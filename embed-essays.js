import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import Database from 'better-sqlite3';
import { LMStudioClient } from '@lmstudio/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class EmbeddingProcessor {
  constructor() {
    this.config = {
      lmstudio: {
        host: process.env.LMSTUDIO_HOST || 'localhost',
        port: process.env.LMSTUDIO_PORT || '1234',
      },
    };

    this.client = new LMStudioClient({
      baseUrl: `ws://${this.config.lmstudio.host}:${this.config.lmstudio.port}`,
    });

    this.db = new Database(path.join(__dirname, 'essays.db'));
  }

  async ensureColumns() {
    // Ensure we have separate columns for title and body embeddings
    try {
      this.db.exec('ALTER TABLE essays ADD COLUMN title_embedding TEXT;');
      console.log('Added title_embedding column.');
    } catch (e) {
      // Column likely already exists
    }
    try {
      this.db.exec('ALTER TABLE essays ADD COLUMN body_embedding TEXT;');
      console.log('Added body_embedding column.');
    } catch (e) {
      // Column likely already exists
    }
  }

  normalizeBody(text) {
    if (!text) return "";
    // Remove all whitespace including newlines and tabs to eliminate PDF artifacts
    return text.replace(/\s+/g, "");
  }

  async run() {
    await this.ensureColumns();

    const essays = this.db.prepare('SELECT id, title, body FROM essays WHERE title_embedding IS NULL OR body_embedding IS NULL').all();
    console.log(`Found ${essays.length} essays to embed.`);

    const embedModel = await this.client.embedding.model("text-embedding-bge-m3");
    const updateStmt = this.db.prepare('UPDATE essays SET title_embedding = ?, body_embedding = ? WHERE id = ?');

    for (const essay of essays) {
      try {
        // Skip records where both title and body are NULL or whitespace-only
        const hasTitle = essay.title && essay.title.trim().length > 0;
        const hasBody = essay.body && essay.body.trim().length > 0;
        if (!hasTitle && !hasBody) {
          console.log(`Skipping essay ID ${essay.id} as it has no title or body.`);
          continue;
        }

        console.log(`Embedding essay ID ${essay.id}...`);

        // Embed title as is
        const titleResult = await embedModel.embed(essay.title || "");
        const titleEmbedding = JSON.stringify(titleResult.embedding);

        // Embed body after removing all whitespace/newlines
        const cleanedBody = this.normalizeBody(essay.body);
        const bodyResult = await embedModel.embed(cleanedBody);
        const bodyEmbedding = JSON.stringify(bodyResult.embedding);

        updateStmt.run(titleEmbedding, bodyEmbedding, essay.id);
      } catch (e) {
        console.error(`Failed to embed essay ID ${essay.id}:`, e);
      }
    }
    console.log('Embedding process completed.');
  }
}


const processor = new EmbeddingProcessor();
processor.run().catch(console.error);
