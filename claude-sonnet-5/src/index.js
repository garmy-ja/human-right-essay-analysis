import 'dotenv/config';
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';

import { extractPdfText } from './pdfText.js';
import { extractFieldsWithLLM } from './extractFields.js';
import { openDb, findBySourceFile, upsertEssay } from './db.js';

const MIN_TEXT_LENGTH = 200; // これ未満はスキャン画像PDF等を疑い、OCR行き(needs_ocr)にする閾値

function parseArgs(argv) {
  const args = { concurrency: 3, db: './essays.sqlite3' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--export-markdown') args.exportMarkdown = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`使い方:
  node src/index.js --root <受賞作文PDFのルートディレクトリ> [オプション]

オプション:
  --db <path>              出力するSQLiteファイル (既定: ./essays.sqlite3)
  --concurrency <n>         LLM呼び出しの並列数 (既定: 3)
  --limit <n>               処理するファイル数の上限（動作確認用）
  --force                    既にDBにある且つファイルハッシュが同じでも再処理する
  --dry-run                  DBに書き込まず、抽出結果を標準出力するだけ
  --export-markdown <dir>    SQLiteに加えて、人間が読める Markdown も出力する

環境変数 (.env, .env.example を参照):
  OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL
`);
}

/** root/YYYY/**.pdf を再帰的に列挙する。YYYY は4桁の数字ディレクトリ名。 */
async function listPdfFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.isDirectory() && /^\d{4}$/.test(e.name)) {
      const year = Number(e.name);
      const yearDir = path.join(root, e.name);
      const pdfs = await walkForPdf(yearDir);
      for (const f of pdfs) files.push({ year, filePath: f });
    }
  }
  return files;
}

async function walkForPdf(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkForPdf(p)));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) out.push(p);
  }
  return out;
}

function toMarkdown(row) {
  const fm = [
    '---',
    `year: ${row.year}`,
    `award_name: ${JSON.stringify(row.award_name ?? null)}`,
    `title: ${JSON.stringify(row.title ?? null)}`,
    `prefecture: ${JSON.stringify(row.prefecture ?? null)}`,
    `school: ${JSON.stringify(row.school ?? null)}`,
    `grade_text: ${JSON.stringify(row.grade_text ?? null)}`,
    `grade_num: ${row.grade_num ?? 'null'}`,
    `author_name: ${JSON.stringify(row.author_name ?? null)}`,
    `author_kana: ${JSON.stringify(row.author_kana ?? null)}`,
    `source_file: ${JSON.stringify(row.source_file)}`,
    `extraction_status: ${JSON.stringify(row.extraction_status)}`,
    '---',
    '',
    `# ${row.title ?? '(タイトル不明)'}`,
    '',
    row.body ?? '',
    '',
  ].join('\n');
  return fm;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.root) {
    printHelp();
    if (!args.root) process.exitCode = 1;
    return;
  }

  const llm = {
    baseUrl: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  };
  if (!args.dryRun && (!llm.baseUrl || !llm.apiKey || !llm.model)) {
    console.error(
      'OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL を .env に設定してください（.env.example 参照）。'
    );
    process.exitCode = 1;
    return;
  }

  const db = args.dryRun ? null : openDb(args.db);
  if (args.exportMarkdown) await mkdir(args.exportMarkdown, { recursive: true });

  let files = await listPdfFiles(args.root);
  files.sort((a, b) => a.filePath.localeCompare(b.filePath));
  if (args.limit) files = files.slice(0, args.limit);

  console.log(`対象PDF: ${files.length} 件 (root=${args.root})`);

  const limit = pLimit(Math.max(1, args.concurrency));
  let done = 0;
  let errorCount = 0;
  let skipCount = 0;

  const tasks = files.map(({ year, filePath }) =>
    limit(async () => {
      const relPath = path.relative(args.root, filePath);
      try {
        const { text, sha256 } = await extractPdfText(filePath);

        // テキスト層がほぼ空 = スキャン画像PDF等の可能性が高い。
        // その場合はLLM抽出を試みても無駄なので、OCR等が必要な要対応キューとして記録するだけにする。
        if (text.trim().length < MIN_TEXT_LENGTH) {
          if (!args.dryRun) {
            upsertEssay(db, {
              year,
              source_file: relPath,
              file_sha256: sha256,
              raw_text: text,
              extraction_status: 'needs_ocr',
              extraction_notes: `抽出テキストが${text.trim().length}文字のみ。スキャン画像PDF等の可能性があり、OCR(例: anydoc等)による再処理が必要。`,
            });
          }
          errorCount++;
          return;
        }

        if (!args.dryRun && !args.force) {
          const existing = findBySourceFile(db, relPath);
          if (existing && existing.file_sha256 === sha256 && existing.extraction_status === 'ok') {
            skipCount++;
            return;
          }
        }

        const result = await extractFieldsWithLLM({ rawText: text, llm });

        const row = {
          year,
          source_file: relPath,
          file_sha256: sha256,
          raw_text: text,
          extraction_model: llm.model,
        };

        if (result.ok) {
          Object.assign(row, result.fields, { extraction_status: 'ok', extraction_notes: result.fields.notes ?? null });
        } else {
          row.extraction_status = 'error';
          row.extraction_notes = result.error;
        }

        if (args.dryRun) {
          console.log(`--- ${relPath} ---`);
          console.log(JSON.stringify(row, null, 2));
        } else {
          upsertEssay(db, row);
          if (args.exportMarkdown) {
            const outPath = path.join(args.exportMarkdown, String(year), `${path.basename(relPath, '.pdf')}.md`);
            await mkdir(path.dirname(outPath), { recursive: true });
            await writeFile(outPath, toMarkdown(row), 'utf8');
          }
        }

        if (result.ok !== true) errorCount++;
      } catch (err) {
        errorCount++;
        console.error(`[ERROR] ${relPath}: ${err.message}`);
        if (!args.dryRun) {
          upsertEssay(db, {
            year,
            source_file: relPath,
            extraction_status: 'error',
            extraction_notes: String(err.message ?? err),
          });
        }
      } finally {
        done++;
        if (done % 10 === 0 || done === files.length) {
          console.log(`進捗: ${done}/${files.length} (エラー ${errorCount} / スキップ ${skipCount})`);
        }
      }
    })
  );

  await Promise.all(tasks);
  console.log(`完了: ${done} 件処理, エラー ${errorCount} 件, スキップ ${skipCount} 件`);
  if (db) db.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
