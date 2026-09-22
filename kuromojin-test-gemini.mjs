const Database = require('better-sqlite3');
const { tokenize } = require('kuromojin');

async function analyzeSqliteText() {
  let db;
  try {
    // 1. SQLiteデータベースに接続
    db = new Database('essays.db');
    const stmt = db.prepare('SELECT title FROM essays');
    const rows = stmt.all();

    const frequencyMap = {};

    // 2. 1行ずつループ処理
    for (const row of rows) {
      if (!row.title) continue;

      // kuromojin の tokenize は Promise を返すので await できる
      const tokens = await tokenize(row.title);

      for (const token of tokens) {
        // 名詞のみを抽出
        if (token.pos === '名詞') {
          const word = token.surface_form;
          frequencyMap[word] = (frequencyMap[word] || 0) + 1;
        }
      }
    }

    // 3. 結果のソートと出力
    const sorted = Object.entries(frequencyMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10);

    console.log('=== 出現頻度 Top 10 ===');
    sorted.forEach(([word, count], i) => {
      console.log(`${i + 1}. ${word}: ${count}回`);
    });

  } catch (err) {
    console.error('処理中にエラーが発生しました:', err);
  } finally {
    if (db) db.close();
  }
}

analyzeSqliteText();