#!/usr/bin/env node
/**
 * 全国中学生人権作文コンテスト PDF corpus ingester
 * Node.js >= 22
 *
 * Canonical store: SQLite
 * Human-auditable mirror: one Markdown file per essay
 * Optional LLM metadata normalization: OpenAI-compatible Chat Completions endpoint
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { toMarkdown } from '@firecrawl/anydoc';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.input) {
  printHelp();
  process.exit(args.help ? 0 : 2);
}

const inputRoot = path.resolve(args.input);
const outputRoot = path.resolve(args.output ?? './output');
const markdownDir = path.join(outputRoot, 'markdown');
const dbPath = path.join(outputRoot, args.db ?? 'essays.sqlite3');
const llmEnabled = Boolean(args.llm || process.env.OPENAI_COMPAT_BASE_URL);

await fs.mkdir(outputRoot, { recursive: true });
await fs.mkdir(markdownDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
initDb(db);

const pdfs = await findPdfs(inputRoot);
console.log(`Found ${pdfs.length} PDF(s).`);

const statements = prepareStatements(db);
let ok = 0, failed = 0, llmUsed = 0;

for (let i = 0; i < pdfs.length; i++) {
  const pdfPath = pdfs[i];
  const rel = path.relative(inputRoot, pdfPath);
  console.log(`[${i + 1}/${pdfs.length}] ${rel}`);
  try {
    const result = await processPdf(pdfPath, inputRoot, markdownDir, llmEnabled);
    upsertEssay(db, statements, result);
    ok++;
    if (result.llm?.used) llmUsed++;
  } catch (err) {
    failed++;
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`  ERROR: ${message}`);
    recordFailure(db, pdfPath, inputRoot, message);
  }
}

await exportJsonl(db, path.join(outputRoot, 'essays.jsonl'));
await exportCsv(db, path.join(outputRoot, 'essays_metadata.csv'));

db.close();
console.log(`Done. ok=${ok} failed=${failed} llmUsed=${llmUsed}`);
console.log(`SQLite : ${dbPath}`);
console.log(`Markdown: ${markdownDir}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--output' || a === '-o') out.output = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--llm') out.llm = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:\n  node src/ingest.mjs --input ./pdf-corpus --output ./output\n\nOptions:\n  --input, -i DIR   Corpus root. Immediate/recursive parent folder must contain 4-digit year.\n  --output, -o DIR  Output root. Default: ./output\n  --db FILE         SQLite filename under output. Default: essays.sqlite3\n  --llm             Normalize metadata through an OpenAI-compatible endpoint.\n\nLLM environment variables:\n  OPENAI_COMPAT_BASE_URL  e.g. https://api.example.com/v1\n  OPENAI_COMPAT_API_KEY   API key\n  OPENAI_COMPAT_MODEL      default: gpt-4.1-mini\n\nOptional local PDF fallback:\n  If anydoc fails, the program tries pdftotext -layout when installed.\n  For image-only/scanned PDFs, use an OCR pre-pass (e.g. OCRmyPDF + Tesseract jpn)\n  or anydoc --ocr hosted separately. The ingestion program never rewrites the source PDF.\n`);
}

async function findPdfs(root) {
  const out = [];
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile() && p.toLowerCase().endsWith('.pdf')) out.push(p);
    }
  }
  await walk(root);
  return out.sort((a, b) => a.localeCompare(b, 'ja'));
}

function yearFromPath(pdfPath, root) {
  const parts = path.relative(root, pdfPath).split(path.sep).filter(Boolean);
  for (const part of [...parts].reverse()) {
    const m = part.match(/^(\d{4})$/);
    if (m) return Number(m[1]);
  }
  return null;
}

async function processPdf(pdfPath, root, markdownDir, llm) {
  const bytes = await fs.readFile(pdfPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const rel = path.relative(root, pdfPath);
  const year = yearFromPath(pdfPath, root);
  const fileStat = await fs.stat(pdfPath);

  let extracted, method;
  try {
    extracted = await toMarkdown(pdfPath, { ocr: 'hosted' });
    method = 'anydoc';
  } catch (err) {
    console.warn(`  anydoc failed: ${err?.message ?? err}; trying pdftotext -layout`);
    extracted = await pdftotext(pdfPath);
    method = 'pdftotext-layout';
  }

  extracted = cleanExtractedMarkdown(extracted);
  const fields = heuristicParse(extracted, year, rel);
  const warnings = validateFields(fields);

  let normalized = null;
  let llmInfo = { used: false };
  if (llm) {
    try {
      normalized = await llmNormalize(extracted, fields);
      llmInfo = { used: true, model: normalized.__model ?? null };
      delete normalized.__model;
      Object.assign(fields, mergeLlmFields(fields, normalized));
    } catch (err) {
      warnings.push(`LLM normalization failed: ${err?.message ?? err}`);
      llmInfo = { used: false, error: err?.message ?? String(err) };
    }
  }

  fields.body = normalizeBody(fields.body);
  const bodyHash = crypto.createHash('sha256').update(fields.body, 'utf8').digest('hex');
  const id = `${year ?? 'unknown'}-${sha256.slice(0, 16)}`;
  const record = {
    id,
    award_year: year,
    award_name: fields.award_name ?? null,
    title: fields.title ?? null,
    prefecture: fields.prefecture ?? null,
    school: fields.school ?? null,
    grade: fields.grade ?? null,
    author_name: fields.author_name ?? null,
    body: fields.body,
    raw_text: extracted,
    source_file: rel,
    source_basename: path.basename(pdfPath),
    source_sha256: sha256,
    body_sha256: bodyHash,
    file_size: fileStat.size,
    extracted_at: new Date().toISOString(),
    extraction_method: method,
    status: warnings.length ? 'warning' : 'ok',
    warnings: JSON.stringify(warnings),
    llm_json: normalized ? JSON.stringify(normalized) : null,
    llm_used: llmInfo.used ? 1 : 0
  };

  const mdName = safeFileName(`${record.award_year ?? 'unknown'}_${record.id}.md`);
  const mdPath = path.join(markdownDir, mdName);
  await fs.writeFile(mdPath, renderMarkdown(record), 'utf8');
  record.markdown_path = path.relative(path.dirname(dbPath), mdPath).split(path.sep).join('/');
  return { ...record, llm: llmInfo };
}

function cleanExtractedMarkdown(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function heuristicParse(text, year, rel) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  // Markdown emphasis is often introduced by anydoc. Remove only wrapper marks.
  const cleanLine = s => s.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();

  const cleaned = lines.map(cleanLine);
  const awardRe = /(?:法務事務次官賞|法務大臣賞|文部科学大臣賞|協賛企業賞|奨励賞|優秀賞|最優秀賞|特別賞|会長賞|[\p{Script=Han}・「」『』（）()\s]+賞)$/u;
  let awardIdx = -1;
  let awardName = null;
  for (let i = 0; i < Math.min(cleaned.length, 20); i++) {
    if (awardRe.test(cleaned[i])) { awardIdx = i; awardName = cleaned[i]; break; }
  }

  let yearLineIdx = cleaned.findIndex(s => /第\s*\d+回.*全国中学生人権作文コンテスト/.test(s));
  if (yearLineIdx < 0) yearLineIdx = -1;

  const headerStart = Math.max(0, Math.max(awardIdx, yearLineIdx) + 1);
  // Candidate title = short line before prefecture/school/grade line.
  let metaIdx = -1;
  const metaRe = /.+?(都|道|府|県).+?(中学校|中学|学校).*?[0-9０-９一二三年]/u;
  for (let i = headerStart; i < Math.min(cleaned.length, headerStart + 12); i++) {
    if (metaRe.test(cleaned[i]) && /[0-9０-９一二三]/u.test(cleaned[i])) { metaIdx = i; break; }
  }
  let title = null;
  if (metaIdx > 0) {
    const candidates = cleaned.slice(headerStart, metaIdx).filter(s => !/全国中学生人権作文コンテスト/.test(s));
    title = candidates.length ? candidates[candidates.length - 1] : null;
  }

  const metaLine = metaIdx >= 0 ? cleaned[metaIdx] : '';
  const parsedMeta = parseMetaLine(metaLine);
  let authorName = parsedMeta.author_name;
  // The author can be on the next line in older layouts.
  if (!authorName && metaIdx >= 0 && metaIdx + 1 < cleaned.length) {
    const a = cleaned[metaIdx + 1];
    if (/^[一-龯々ぁ-んァ-ヶー\s　]+(?:（[^）]+）)?$/.test(a)) authorName = a;
  }

  let bodyStart = metaIdx >= 0 ? metaIdx + 1 : Math.min(cleaned.length, 4);
  if (authorName && cleaned[bodyStart] === authorName) bodyStart++;
  const bodyLines = cleaned.slice(bodyStart);
  // Strip contest/award artifacts that may occur at page footer/header.
  const body = bodyLines
    .filter(s => !/^第\s*\d+回.*全国中学生人権作文コンテスト$/.test(s))
    .filter(s => !awardName || s !== awardName)
    .join('\n')
    .trim();

  return {
    award_year: year,
    award_name: awardName,
    title,
    prefecture: parsedMeta.prefecture,
    school: parsedMeta.school,
    grade: parsedMeta.grade,
    author_name: authorName,
    body,
    source_file: rel
  };
}

function parseMetaLine(line) {
  if (!line) return { prefecture: null, school: null, grade: null, author_name: null };
  const normalized = line.replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
  const gm = normalized.match(/^(.*?)\s*([0-9０-９一二三]+)年(?:\s+(.+))?$/u);
  if (!gm) return { prefecture: null, school: null, grade: null, author_name: null };

  const left = gm[1].trim();
  const grade = gm[2].replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const author_name = gm[3]?.trim() ?? null;

  // Split prefecture at the first Japanese prefecture suffix. This handles
  // layouts such as "長崎県・県立長崎東中学校" without treating "県立" as
  // part of the prefecture value.
  const pm = left.match(/^(.*?(?:東京都|北海道|(?:京都|大阪)府|.{1,3}県))(?:[・、, ]+|$)(.*)$/u);
  let prefecture = pm?.[1]?.trim() ?? null;
  let school = pm?.[2]?.trim() ?? left;
  if (!prefecture) {
    const simple = left.match(/^(.*?(?:都|道|府|県))(.*)$/u);
    prefecture = simple?.[1]?.trim() ?? null;
    school = simple?.[2]?.trim() ?? left;
  }
  return { prefecture, school: school || null, grade, author_name };
}

function normalizeBody(body) {
  return body
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    // common PDF extraction artifact: spaces inserted inside Japanese punctuation
    .replace(/[ \t]+([、。」』，．！？])/g, '$1')
    .replace(/([「『（(])[ \t]+/g, '$1')
    .trim();
}

function validateFields(f) {
  const w = [];
  for (const key of ['award_name', 'title', 'prefecture', 'school', 'grade', 'author_name', 'body']) {
    if (!f[key]) w.push(`missing:${key}`);
  }
  if (!f.award_year) w.push('missing:award_year (4-digit year folder not found)');
  if (f.body && f.body.length < 200) w.push('body_suspiciously_short');
  return w;
}

async function pdftotext(pdfPath) {
  return await new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', pdfPath, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`pdftotext exit=${code}: ${Buffer.concat(err).toString('utf8')}`));
      else resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

async function llmNormalize(text, heuristic) {
  const baseUrl = (process.env.OPENAI_COMPAT_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.OPENAI_COMPAT_API_KEY || '';
  const model = process.env.OPENAI_COMPAT_MODEL || 'gpt-4.1-mini';
  if (!baseUrl) throw new Error('OPENAI_COMPAT_BASE_URL is not set');

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      award_name: { type: ['string', 'null'] },
      title: { type: ['string', 'null'] },
      prefecture: { type: ['string', 'null'] },
      school: { type: ['string', 'null'] },
      grade: { type: ['string', 'null'] },
      author_name: { type: ['string', 'null'] },
      body: { type: 'string' },
      confidence: { type: 'number' },
      notes: { type: 'string' }
    },
    required: ['award_name','title','prefecture','school','grade','author_name','body','confidence','notes']
  };

  const prompt = `Extract structured fields from a Japanese prize essay PDF extraction. Preserve the essay body verbatim except obvious PDF line/space artifacts. Do not summarize or paraphrase.\n\nHeuristic result (may be wrong):\n${JSON.stringify(heuristic, null, 2)}\n\nRaw extracted Markdown:\n${text}`;
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a document metadata extraction engine. Return JSON only.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'essay_fields', strict: true, schema } }
    })
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM response did not contain choices[0].message.content');
  const json = JSON.parse(content);
  json.__model = model;
  return json;
}

function mergeLlmFields(base, llm) {
  const result = {};
  for (const k of ['award_name','title','prefecture','school','grade','author_name','body']) {
    if (llm[k] != null && String(llm[k]).trim() !== '') result[k] = String(llm[k]).trim();
  }
  return result;
}

function safeFileName(s) {
  return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

function renderMarkdown(r) {
  return `---\nid: ${yaml(r.id)}\naward_year: ${r.award_year ?? ''}\naward_name: ${yaml(r.award_name)}\ntitle: ${yaml(r.title)}\nprefecture: ${yaml(r.prefecture)}\nschool: ${yaml(r.school)}\ngrade: ${yaml(r.grade)}\nauthor_name: ${yaml(r.author_name)}\nsource_file: ${yaml(r.source_file)}\nsource_sha256: ${r.source_sha256}\nbody_sha256: ${r.body_sha256}\nextraction_method: ${r.extraction_method}\nstatus: ${r.status}\nwarnings: ${yaml(r.warnings)}\n---\n\n# ${r.title ?? '(タイトル不明)'}\n\n## 本文\n\n${r.body}\n\n## 抽出元テキスト\n\n<details>\n<summary>raw_text</summary>\n\n${r.raw_text}\n\n</details>\n`;
}

function yaml(v) {
  if (v == null) return 'null';
  const s = String(v).replace(/'/g, "''");
  return `'${s}'`;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS essays (
      id TEXT PRIMARY KEY,
      award_year INTEGER,
      award_name TEXT,
      title TEXT,
      prefecture TEXT,
      school TEXT,
      grade TEXT,
      author_name TEXT,
      body TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      source_file TEXT NOT NULL UNIQUE,
      source_basename TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      extracted_at TEXT NOT NULL,
      extraction_method TEXT NOT NULL,
      status TEXT NOT NULL,
      warnings TEXT,
      llm_json TEXT,
      llm_used INTEGER NOT NULL DEFAULT 0,
      markdown_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_essays_year ON essays(award_year);
    CREATE INDEX IF NOT EXISTS idx_essays_award ON essays(award_name);
    CREATE INDEX IF NOT EXISTS idx_essays_prefecture ON essays(prefecture);
    CREATE INDEX IF NOT EXISTS idx_essays_grade ON essays(grade);
    CREATE VIRTUAL TABLE IF NOT EXISTS essays_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      content='essays',
      content_rowid='rowid',
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS essays_ai AFTER INSERT ON essays BEGIN
      INSERT INTO essays_fts(rowid, id, title, body) VALUES (new.rowid, new.id, new.title, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS essays_ad AFTER DELETE ON essays BEGIN
      INSERT INTO essays_fts(essays_fts, rowid, id, title, body) VALUES ('delete', old.rowid, old.id, old.title, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS essays_au AFTER UPDATE ON essays BEGIN
      INSERT INTO essays_fts(essays_fts, rowid, id, title, body) VALUES ('delete', old.rowid, old.id, old.title, old.body);
      INSERT INTO essays_fts(rowid, id, title, body) VALUES (new.rowid, new.id, new.title, new.body);
    END;
  `);
}

function prepareStatements(db) {
  return {
    upsert: db.prepare(`INSERT INTO essays (
      id, award_year, award_name, title, prefecture, school, grade, author_name, body,
      raw_text, source_file, source_basename, source_sha256, body_sha256, file_size,
      extracted_at, extraction_method, status, warnings, llm_json, llm_used, markdown_path
    ) VALUES (
      @id, @award_year, @award_name, @title, @prefecture, @school, @grade, @author_name, @body,
      @raw_text, @source_file, @source_basename, @source_sha256, @body_sha256, @file_size,
      @extracted_at, @extraction_method, @status, @warnings, @llm_json, @llm_used, @markdown_path
    ) ON CONFLICT(source_file) DO UPDATE SET
      id=excluded.id, award_year=excluded.award_year, award_name=excluded.award_name,
      title=excluded.title, prefecture=excluded.prefecture, school=excluded.school,
      grade=excluded.grade, author_name=excluded.author_name, body=excluded.body,
      raw_text=excluded.raw_text, source_basename=excluded.source_basename,
      source_sha256=excluded.source_sha256, body_sha256=excluded.body_sha256,
      file_size=excluded.file_size, extracted_at=excluded.extracted_at,
      extraction_method=excluded.extraction_method, status=excluded.status,
      warnings=excluded.warnings, llm_json=excluded.llm_json, llm_used=excluded.llm_used,
      markdown_path=excluded.markdown_path`)
  };
}

function upsertEssay(db, statements, record) {
  const tx = db.transaction(() => statements.upsert.run(record));
  tx();
}

function recordFailure(db, pdfPath, root, error) {
  db.exec(`CREATE TABLE IF NOT EXISTS failures (source_file TEXT PRIMARY KEY, error TEXT, recorded_at TEXT)`);
  db.prepare(`INSERT INTO failures(source_file,error,recorded_at) VALUES(?,?,?) ON CONFLICT(source_file) DO UPDATE SET error=excluded.error, recorded_at=excluded.recorded_at`)
    .run(path.relative(root, pdfPath), error, new Date().toISOString());
}

async function exportJsonl(db, target) {
  const rows = db.prepare(`SELECT * FROM essays ORDER BY award_year, id`).all();
  const lines = rows.map(r => JSON.stringify({ ...r, warnings: parseJson(r.warnings), llm: parseJson(r.llm_json) }));
  await fs.writeFile(target, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

async function exportCsv(db, target) {
  const rows = db.prepare(`SELECT award_year,award_name,title,prefecture,school,grade,author_name,source_file,status,extraction_method,llm_used FROM essays ORDER BY award_year,id`).all();
  const header = Object.keys(rows[0] ?? {award_year:'',award_name:'',title:'',prefecture:'',school:'',grade:'',author_name:'',source_file:'',status:'',extraction_method:'',llm_used:''});
  const csv = [header, ...rows.map(r => header.map(k => csvEscape(r[k])))].map(a => a.join(',')).join('\n') + '\n';
  await fs.writeFile(target, csv, 'utf8');
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return s; } }
