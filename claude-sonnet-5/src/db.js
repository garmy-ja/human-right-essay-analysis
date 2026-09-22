import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS essays (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  year                INTEGER NOT NULL,          -- フォルダ名から取得した開催(西暦)年
  award_name          TEXT,                      -- 例: 法務事務次官賞
  title               TEXT,
  prefecture          TEXT,                      -- 例: 宮崎県
  school              TEXT,                      -- 例: 宮崎市立久峰中学校
  grade_text          TEXT,                      -- 元表記 例: ３年
  grade_num           INTEGER,                   -- 正規化 1/2/3
  author_name         TEXT,                      -- 漢字表記
  author_kana         TEXT,                      -- ふりがな（取得できた場合）
  body                TEXT,                      -- ヘッダー/フッター等を除去した本文
  char_count          INTEGER,                   -- body の文字数（集計用に事前計算）
  source_file         TEXT NOT NULL UNIQUE,       -- 元PDFの相対パス（再実行の重複防止キー）
  file_sha256         TEXT,                      -- 元PDFのハッシュ（差し替え検知用）
  raw_text            TEXT,                      -- pdf-parse の生抽出テキスト（再処理用に保持）
  extraction_model    TEXT,                      -- 抽出に使ったLLMモデル名
  extraction_status   TEXT NOT NULL DEFAULT 'ok', -- ok / needs_review / error
  extraction_notes    TEXT,                      -- LLMが申告した不確実点や、パース失敗時のエラー内容
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_essays_year       ON essays(year);
CREATE INDEX IF NOT EXISTS idx_essays_prefecture ON essays(prefecture);
CREATE INDEX IF NOT EXISTS idx_essays_award      ON essays(award_name);
CREATE INDEX IF NOT EXISTS idx_essays_status     ON essays(extraction_status);

-- 全文検索（日本語対応の unicode61 トークナイザ。形態素解析ではないが素朴な部分一致検索には十分）
CREATE VIRTUAL TABLE IF NOT EXISTS essays_fts USING fts5(
  title, body, content='essays', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS essays_ai AFTER INSERT ON essays BEGIN
  INSERT INTO essays_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS essays_ad AFTER DELETE ON essays BEGIN
  INSERT INTO essays_fts(essays_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS essays_au AFTER UPDATE ON essays BEGIN
  INSERT INTO essays_fts(essays_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
  INSERT INTO essays_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- 将来 LLM 埋め込みベクトルを追加する際の受け皿（今回は未使用。クラスタリング等で利用する想定）
CREATE TABLE IF NOT EXISTS essay_embeddings (
  essay_id   INTEGER NOT NULL REFERENCES essays(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,        -- Float32Array をそのままBLOB化する想定
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (essay_id, model)
);
`;

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function findBySourceFile(db, sourceFile) {
  return db.prepare('SELECT * FROM essays WHERE source_file = ?').get(sourceFile);
}

const upsertStmtText = `
INSERT INTO essays (
  year, award_name, title, prefecture, school, grade_text, grade_num,
  author_name, author_kana, body, char_count, source_file, file_sha256,
  raw_text, extraction_model, extraction_status, extraction_notes, updated_at
) VALUES (
  @year, @award_name, @title, @prefecture, @school, @grade_text, @grade_num,
  @author_name, @author_kana, @body, @char_count, @source_file, @file_sha256,
  @raw_text, @extraction_model, @extraction_status, @extraction_notes, datetime('now')
)
ON CONFLICT(source_file) DO UPDATE SET
  year = excluded.year,
  award_name = excluded.award_name,
  title = excluded.title,
  prefecture = excluded.prefecture,
  school = excluded.school,
  grade_text = excluded.grade_text,
  grade_num = excluded.grade_num,
  author_name = excluded.author_name,
  author_kana = excluded.author_kana,
  body = excluded.body,
  char_count = excluded.char_count,
  file_sha256 = excluded.file_sha256,
  raw_text = excluded.raw_text,
  extraction_model = excluded.extraction_model,
  extraction_status = excluded.extraction_status,
  extraction_notes = excluded.extraction_notes,
  updated_at = datetime('now')
`;

export function upsertEssay(db, row) {
  const stmt = db.prepare(upsertStmtText);
  stmt.run({
    year: row.year,
    award_name: row.award_name ?? null,
    title: row.title ?? null,
    prefecture: row.prefecture ?? null,
    school: row.school ?? null,
    grade_text: row.grade_text ?? null,
    grade_num: row.grade_num ?? null,
    author_name: row.author_name ?? null,
    author_kana: row.author_kana ?? null,
    body: row.body ?? null,
    char_count: row.body ? [...row.body].length : null,
    source_file: row.source_file,
    file_sha256: row.file_sha256 ?? null,
    raw_text: row.raw_text ?? null,
    extraction_model: row.extraction_model ?? null,
    extraction_status: row.extraction_status ?? 'ok',
    extraction_notes: row.extraction_notes ?? null,
  });
}
