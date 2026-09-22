# 全国中学生人権作文コンテスト PDF Corpus Ingester

1作文1PDFのコーパスを、後続のテキスト分析・ベクトル化・クラスタリング・年次集計に使いやすい形へ変換するNode.js 22向けツールです。

## 推奨する保存方式

**SQLiteを正規データストア、1作文1 Markdown を監査用ミラー**にする構成を推奨します。

- SQLite: 年、賞、県、学校、学年、氏名、本文、元テキスト、ハッシュ、抽出方法、警告などを1行/1作文で管理
- Markdown: 人間が目視確認しやすい。LLM入力や差分確認にも便利
- JSONL: 外部の埋め込み/クラスタリング処理へ渡しやすい
- CSV: メタデータ集計向け
- FTS5: SQLite内で簡単な全文検索が可能

## 入力ディレクトリ

```text
pdf-corpus/
  2006/
    sakubun11.pdf
    ...
  2024/
    001457824.pdf
    ...
```

年フォルダは4桁の西暦。プログラムはPDFから最も近い4桁フォルダ名を受賞年として記録します。

## セットアップ

```bash
npm install
```

## 実行

```bash
node src/ingest.mjs --input ./pdf-corpus --output ./output
```

出力:

```text
output/
  essays.sqlite3
  essays.jsonl
  essays_metadata.csv
  markdown/
    2006_....md
    2024_....md
```

同じPDFを再実行すると `source_file` をキーに更新します。

## PDFテキスト抽出

第1候補は `@firecrawl/anydoc` のローカル変換です。失敗した場合は `pdftotext -layout` にフォールバックします。

スキャン/画像PDFは通常の文字抽出ではなくOCRが必要です。原本をローカルに置いたまま運用したい場合は、OCRmyPDF + Tesseract（日本語モデル `jpn`）による前処理を推奨します。

Firecrawl anydocの hosted OCR を使う方法もありますが、その場合はOCR対象PDFが外部サービスへ送られます。機密性の高い資料では注意してください。

## LLMメタデータ抽出

LLMは本文生成に使わず、**PDF抽出結果から賞名・タイトル・県・学校・学年・氏名の構造化と抽出品質の検証**に限定する設計です。本文は可能な限り非LLMの抽出結果を保持し、後続のembeddingで同じ原文を再現できるようにします。

OpenAI互換 endpoint:

```bash
export OPENAI_COMPAT_BASE_URL=https://example.com/v1
export OPENAI_COMPAT_API_KEY=YOUR_KEY
export OPENAI_COMPAT_MODEL=gpt-4.1-mini
node src/ingest.mjs --input ./pdf-corpus --output ./output --llm
```

エンドポイントは Chat Completions 形式 (`/chat/completions`) を想定しています。`response_format=json_schema` に対応しない互換サーバーでは、`llmNormalize()` をそのサーバーの仕様に合わせて置き換えてください。

## 後続のベクトル化を想定したデータの分離

embedding対象は原則 `body`。`title` や `award_name` は別メタデータとして保持してください。

将来的に複数種類のembeddingモデルを比較するなら、SQLiteに次の別テーブルを追加する設計が扱いやすいです。

```sql
CREATE TABLE embeddings (
  essay_id TEXT,
  model TEXT,
  dimensions INTEGER,
  vector_json TEXT,
  created_at TEXT,
  PRIMARY KEY (essay_id, model)
);
```

大規模になり、ベクトル検索そのものを高速化したくなった段階で、Qdrant / pgvector / LanceDB などへベクトル部分だけを分離すればよく、原文・メタデータはSQLiteを正本として残せます。

## 抽出品質について

自動抽出は必ず `status` と `warnings` を見てください。特にOCRしたPDF、複雑な段組み、縦書き、ページヘッダ・フッタがある資料は自動解析だけで100%正しくならない前提です。

各Markdownには `raw_text` と `source_sha256` も保存されるため、後から抽出処理を改善して再実行できます。
