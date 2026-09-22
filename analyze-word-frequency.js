import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { tokenize } from 'kuromojin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Removes all whitespace characters including newlines and tabs.
 * Reuses logic from embed-essays.js
 */
function normalizeBody(text) {
  if (!text) return "";
  return text.replace(/\s+/g, "");
}

/**
 * Tokenizes text and counts frequencies of specific parts of speech.
 * @param {string} text
 * @param {string[]} posFilter
 * @returns {Map<string, {word: string, pos: string, count: number}>}
 */
async function getWordFrequencies(text, posFilter) {
  const frequencyMap = new Map();
  if (!text) return frequencyMap;

  const tokens = await tokenize(text);
  for (const token of tokens) {
    if (posFilter.includes(token.pos)) {
      const key = `${token.surface_form}|${token.pos}`;
      const current = frequencyMap.get(key);
      if (current) {
        current.count++;
      } else {
        frequencyMap.set(key, {
          word: token.surface_form,
          pos: token.pos,
          count: 1,
        });
      }
    }
  }
  return frequencyMap;
}

async function main() {
  const dbPath = path.join(__dirname, 'essays.db');
  const db = new Database(dbPath);

  console.log('Connected to database at:', dbPath);

  // 1. Setup word_counts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS word_counts (
      essay_id INTEGER,
      word TEXT,
      pos TEXT,
      count INTEGER,
      source TEXT,
      PRIMARY KEY (essay_id, word, pos, source),
      FOREIGN KEY (essay_id) REFERENCES essays(id)
    );
  `);

  // Clear existing counts for a fresh analysis
  db.prepare('DELETE FROM word_counts').run();
  console.log('Cleared existing word counts.');

  // 2. Fetch essays
  const essays = db.prepare('SELECT id, title, body FROM essays').all();
  console.log(`Processing ${essays.length} essays...`);

  const posFilter = ['名詞', '動詞', '形容詞', '副詞'];
  const insertStmt = db.prepare('INSERT INTO word_counts (essay_id, word, pos, count, source) VALUES (?, ?, ?, ?, ?)');

  // Use a transaction for performance
  const insertTransaction = db.transaction((data) => {
    for (const row of data) {
      insertStmt.run(row.essay_id, row.word, row.pos, row.count, row.source);
    }
  });

  const allResults = [];

  for (let i = 0; i < essays.length; i++) {
    const essay = essays[i];
    if (i % 10 === 0) console.log(`Progress: ${i}/${essays.length}...`);

    try {
      // Analyze Title
      const titleFreqs = await getWordFrequencies(essay.title, posFilter);
      for (const {word, pos, count} of titleFreqs.values()) {
        allResults.push({ essay_id: essay.id, word, pos, count, source: 'title' });
      }

      // Analyze Body (with normalization)
      const cleanedBody = normalizeBody(essay.body);
      const bodyFreqs = await getWordFrequencies(cleanedBody, posFilter);
      for (const {word, pos, count} of bodyFreqs.values()) {
        allResults.push({ essay_id: essay.id, word, pos, count, source: 'body' });
      }
    } catch (err) {
      console.error(`Error processing essay ID ${essay.id}:`, err);
    }
  }

  console.log(`Inserting ${allResults.length} records into word_counts...`);
  insertTransaction(allResults);
  console.log('Successfully updated word frequencies.');

  db.close();
}

main().catch(console.error);
