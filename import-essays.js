import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import Database from 'better-sqlite3';
import { LMStudioClient } from '@lmstudio/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class EssayExtractor {
  constructor() {
    this.config = {
      lmstudio: {
        host: process.env.LMSTUDIO_HOST || 'localhost',
        port: process.env.LMSTUDIO_PORT || '1234',
        maxTokens: parseInt(process.env.LMSTUDIO_MAX_TOKENS || '4096'),
        model: process.env.LMSTUDIO_MODEL || 'google/gemma-4-e4b',
      },
    };

    this.client = new LMStudioClient({
      baseUrl: `ws://${this.config.lmstudio.host}:${this.config.lmstudio.port}`,
    });

    this.db = new Database(path.join(__dirname, 'essays.db'));
  }

  cleanText(text) {
    if (!text) return "";
    // Remove control characters except for newline (\n), carriage return (\r), and tab (\t)
    // Range \x00-\x1F covers most control characters.
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  }

  async initialize() {
    this.model = await this.client.llm.model(this.config.lmstudio.model);
  }

  async respond(finalText) {
    const result = await this.model.respond(
      finalText,
      {
        maxTokens: this.config.lmstudio.maxTokens,
        temperature: 0.7
      }
    );
    if (result.nonReasoningContent) {
      return result.nonReasoningContent;
    } else {
      return result.content;
    }
  }

  async extractEssayData(year, rawText) {
    const prompt = `
あなたは優秀なテキスト解析アシスタントです。
提供された中学生の人権作文から、以下の情報を正確に抽出してJSON形式で出力してください。

【抽出項目】
- award: 受賞した賞の名前（例：「内閣総理大臣賞」「法務事務次官賞」）
- title: 作文のタイトル
- prefecture: 筆者の居住県（例：「沖縄県」「宮城県」）
- school: 筆者の所属する学校名
- grade: 筆者の学年（例：「１年」「三年」）

【制約事項】
- 出力は純粋なJSON形式のみとしてください。解説や導入文は不要です。
- 筆者の氏名やフリガナは絶対に含めないでください。
- 該当する項目が見つからない場合は null としてください。

【対象テキスト（${year}年度）】
${rawText}
`;

    const response = await this.respond(prompt);
    try {
      // Extract JSON from response (in case LLM adds markdown code blocks)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error(`Failed to parse JSON for year ${year}:`, e);
      return null;
    }
  }

  async run() {
    const essayDir = path.join(__dirname, 'essay-text');
    const files = await fs.readdir(essayDir);

    console.log(`Found ${files.length} files. Starting extraction...`);

    const insertStmt = this.db.prepare(`
      INSERT INTO essays (year, award, title, prefecture, school, grade, body, raw_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      if (!file.endsWith('.txt') && !file.endsWith('.md')) continue;

      const filePath = path.join(essayDir, file);
      const rawText = await fs.readFile(filePath, 'utf-8');

      // Extract year from filename (e.g., "2006_sakubun01.txt" -> 2006)
      const yearMatch = file.match(/^(\d{4})/);
      const year = yearMatch ? parseInt(yearMatch[1]) : null;

      console.log(`Processing ${file}...`);
      const data = await this.extractEssayData(year, rawText);

      if (data) {
        const cleanedText = this.cleanText(rawText);
        insertStmt.run(
          year,
          data.award,
          data.title,
          data.prefecture,
          data.school,
          data.grade,
          cleanedText, // Store cleaned raw text in body column
          rawText       // Store original raw text in raw_text column
        );
        console.log(`Successfully imported ${file}`);
      } else {
        console.error(`Skipped ${file} due to extraction error.`);
      }
    }
    console.log('Import completed.');
  }

}

const extractor = new EssayExtractor();
await extractor.initialize().then(() => extractor.run()).catch(console.error);
