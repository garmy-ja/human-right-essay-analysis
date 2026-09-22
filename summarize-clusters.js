import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import Database from 'better-sqlite3';
import { LMStudioClient } from '@lmstudio/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class ClusterSummarizer {
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

  async initialize() {
    this.model = await this.client.llm.model(this.config.lmstudio.model);
  }

  async respond(prompt) {
    const result = await this.model.respond(
      prompt,
      {
        maxTokens: this.config.lmstudio.maxTokens,
        temperature: 0.7
      }
    );
    return result.nonReasoningContent || result.content;
  }

  async run() {
    await this.initialize();

    // 1. クラスタ一覧を取得
    const clusters = this.db.prepare("SELECT DISTINCT cluster FROM essays_body_cluster ORDER BY cluster ASC").all();
    const reportPath = path.join(__dirname, 'cluster_summary_report.md');

    // 初期化: ファイルを新規作成してヘッダーを書き込む
    await fs.writeFile(reportPath, "# 作文クラスタ分析レポート\n\n", 'utf-8');

    for (const { cluster } of clusters) {
      if (cluster === '-1') {
        console.log("Skipping noise cluster (-1)...");
        continue;
      }

      console.log(`Processing cluster ${cluster}...`);

      // 2. そのクラスタに属する作文の本文をすべて取得
      const essays = this.db.prepare(`
        SELECT e.body
        FROM essays e
        JOIN essays_body_cluster c ON e.id = c.id
        WHERE c.cluster = ?
      `).all(cluster);

      const combinedText = essays.map(e => e.body).join("\n\n---\n\n");

      // 3. 要約プロンプトの作成
      const prompt = `
あなたは優秀なテキスト解析アシスタントです。
提供された複数の作文（同じクラスタに分類されたもの）を読み、それらに共通する特徴を抽出して要約してください。

【分析視点】
以下の項目について、共通点が分かるようにまとめてください：
- 登場人物はどのような人たちか
- 取り扱うテーマはなにか
- 誰か明確な悪いひと・悪いことは示されているか
- 問題・課題に対してどのような行動を取ったり向き合い方をするのか
- 問題・課題に対して社会や行政がすべきことを提案しているか。提案しているときはその内容はなにか。

【制約事項】
- 最後に、これらを踏まえて「一言でどのような作文なのか」という特徴を簡潔に示してください。
- 全体で10行程度のボリュームに抑制してください。
- 出力はMarkdown形式で、箇条書きを用いて簡潔に記述してください。

【対象テキスト】
${combinedText}
`;

      let summaryResult = "";
      try {
        summaryResult = await this.respond(prompt);
        console.log(`Cluster ${cluster} summarized.`);
      } catch (e) {
        console.error(`Failed to summarize cluster ${cluster}:`, e);
        summaryResult = "(要約に失敗しました)";
      }

      // 処理が終わるたびにファイルに追記
      const entry = `## クラスタ ${cluster}\n\n${summaryResult}\n\n---\n\n`;
      await fs.appendFile(reportPath, entry, 'utf-8');
    }

    // データベース接続を明示的に閉じる
    this.db.close();
    console.log('Report generated: cluster_summary_report.md');
  }
}

const summarizer = new ClusterSummarizer();
await summarizer.run().catch(console.error);
