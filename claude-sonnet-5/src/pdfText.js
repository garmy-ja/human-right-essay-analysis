import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PDFParse } from 'pdf-parse';

/**
 * PDFファイルからテキストを抽出する。
 * pdf-parse (v2) はページ間に "-- N of M --" という区切りを挿入するため、
 * ここで除去してから返す（LLMのトークンを無駄遣いしないための軽いクリーニング）。
 */
export async function extractPdfText(filePath) {
  const buf = await readFile(filePath);
  const sha256 = createHash('sha256').update(buf).digest('hex');

  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    const text = result.text
      .replace(/\n?--\s*\d+\s*of\s*\d+\s*--\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, numpages: result.total ?? result.pages?.length ?? null, sha256 };
  } finally {
    await parser.destroy();
  }
}
