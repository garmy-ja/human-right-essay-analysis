import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initDb() {
  const dbPath = path.join(__dirname, 'essays.db');
  const db = new Database(dbPath);

  const schema = `
    CREATE TABLE IF NOT EXISTS essays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER,
      award TEXT,
      title TEXT,
      prefecture TEXT,
      school TEXT,
      grade TEXT,
      body TEXT,
      raw_text TEXT,
      embedding TEXT
    );
  `;

  db.exec(schema);
  console.log('Database initialized successfully at:', dbPath);
  return db;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initDb().catch(console.error);
}
