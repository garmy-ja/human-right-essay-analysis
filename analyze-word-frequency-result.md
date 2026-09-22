# 単語出現頻度分析 実施レポート

## 1. 概要
本工程では、構造化した作文データ (`essays.db`) を対象に、テキストマイニングの基礎となる単語出現頻度の集計を実施した。これにより、作品全体でどのような言葉が頻繁に使われているかを定量的に分析することが可能となった。

## 2. 実装内容

### 2.1 分析対象と条件
- **対象データ**: `essays` テーブルの `title`（タイトル）および `body`（本文）。
- **抽出品詞**: 以下の4品詞に限定して抽出。
  - 名詞
  - 動詞
  - 形容詞
  - 副詞
- **テキスト前処理**: 
  - `body` カラムに含まれる不要な空白および改行をすべて除去し、PDF由来のノイズを排除した状態で形態素分析を行った。

### 2.2 技術スタック
- **形態素解析エンジン**: `kuromojin`
- **データベース**: SQLite (`better-sqlite3`)
- **実行環境**: Node.js

### 2.3 DB設計
集計結果を保存するために新テーブル `word_counts` を作成した。単なる合計値ではなく、作文単位で保存することで、後から年度・賞・学年などの属性で再集計（集約）できるように設計した。

**テーブル名: `word_counts`**
| カラム名 | 型 | 内容 |
| :--- | :--- | :--- |
| `essay_id` | INTEGER | `essays` テーブルへの外部キー |
| `word` | TEXT | 抽出された単語（表層形） |
| `pos` | TEXT | 品詞 (`名詞`, `動詞` など) |
| `count` | INTEGER | その作文内での出現回数 |
| `source` | TEXT | 出現箇所 (`'title'` または `'body'`) |
- **主キー**: `(essay_id, word, pos, source)`

## 3. 実行結果
- **実行スクリプト**: `analyze-word-frequency.js`
- **結果**: 全件の形態素解析および DB への保存が正常に完了した。

※人間による加筆：
　初回の指示では過去のコードを参照させなかったため、ディレクトリを漁って他のコードからDB構造を読もうとし始めたので手動停止した。その間のリクエスト回数は20回。
　改めてコードを指示してからのリクエスト回数は34回。
　Claude Codeは作業しなかったので記録されていないが、npm install kuromojin が動かずにローカルのnodeを入れ替えたりnode-gypを入れたりなどのトラブルシューティングが2時間程度かかった。

## 4. 分析方法（クエリ例）
保存されたデータを用いて、以下のような分析を行うことができる。

### 4.1 全体の頻出単語ランキング（本文・名詞のみ）
```sql
SELECT word, SUM(count) as total 
FROM word_counts 
WHERE source = 'body' AND pos = '名詞' 
GROUP BY word 
ORDER BY total DESC 
LIMIT 20;
```

### 4.2 タイトルで頻出する単語ランキング
```sql
SELECT word, SUM(count) as total 
FROM word_counts 
WHERE source = 'title' 
GROUP BY word 
ORDER BY total DESC 
LIMIT 20;
```

### 4.3 特定の年度における頻出単語（`essays` テーブルと結合）
```sql
SELECT wc.word, SUM(wc.count) as total 
FROM word_counts wc
JOIN essays e ON wc.essay_id = e.id
WHERE e.year = 2020 AND wc.source = 'body'
GROUP BY wc.word 
ORDER BY total DESC;
```
