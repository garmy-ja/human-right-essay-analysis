# essay-extractor

全国中学生人権作文コンテストの受賞作文PDF（`<root>/<開催年4桁>/*.pdf`）を読み込み、
テキスト解析（LLM埋め込み・クラスタリング・傾向分析・集計）に使いやすい構造化データへ
変換するパイプラインです。Node.js v22 で動作します。

添付いただいた2つのサンプルPDFを実際に読み込んで検証した上で設計しています
（下記「設計判断の根拠」を参照）。

## 設計判断の根拠（サンプルPDFの実物検証より）

2つのサンプルPDFをテキスト抽出してみたところ、以下が分かりました。

1. **賞名・タイトル・都道府県/学校/学年の並び順が年度によって違う。**
   - 2023年サンプルは本文末尾（ページ境界）に賞名が現れる
   - 2010年サンプルは冒頭に賞名がある
   - 学校名に県名が「・」で結合されているケースもある
2. **ページ境界で「第◯◯回全国中学生人権作文コンテスト」「（賞名）」が
   本文の途中に紛れ込む。** PDFのテキストレイヤーの抽出順序上、ページ送りの
   ヘッダー/フッターが本文の間に挟まってしまうためです。
3. これらは **今回の2ファイルだけでも既にパターンが割れている** ため、44回分
   （数十年、フォーマット変更が複数回あった可能性大）を正規表現だけで確実に
   パースするのは現実的ではありません。

→ そのため、**PDFからの生テキスト抽出は軽量なライブラリで機械的に行い、
「どれがタイトルで、どれが賞名で、本文のノイズはどこか」を判断する部分にLLMを使う**
設計にしています。

## 格納形式の提案: SQLite（＋任意でMarkdownも併用）

### 結論: 一次ストアは **SQLite** を推奨します

理由:

- 後続処理に「開催年ごとの集計」「都道府県別集計」「賞ごとの集計」「傾向の時系列変化」
  が含まれており、これは素直にSQLの `GROUP BY` で処理できるのが大きい。Markdownファイル
  の集合だとYAML frontmatterを毎回全ファイル分パースしないと同じことができません。
- 全文検索が必要になった場合も `FTS5`（本スキーマに同梱）で十分対応可能。
- 将来LLM埋め込みベクトルを追加する際も `essay_embeddings` テーブル（同梱）に
  そのまま乗せられる。同一ファイル内でクラスタIDやラベルを追加するのも容易。
- 1ファイルで完結するため配布・バックアップ・差分管理（DBごとgit管理も可、または
  定期スナップショット）がシンプル。
- 数千件規模でも実用上ボトルネックにならない（`better-sqlite3` は同期APIで高速）。

### Markdownの位置づけ

人間によるレビュー（抽出結果が正しいかの目視チェック、Gitでの差分確認、Obsidian等での
一覧性）には Markdown + YAML frontmatter が便利なので、**SQLiteを正とし、
`--export-markdown` オプションで副産物として書き出す** ハイブリッド構成にしました。
分析パイプライン自体はSQLiteだけを見れば良く、Markdownは人間用のビューという位置づけです。

## PDFテキスト化手段の検討

ご提示のあった [firecrawl/anydoc](https://github.com/firecrawl/anydoc) も検討しましたが、
今回のPDF群には **オーバースペック** と判断し、`pdf-parse`（Node製、外部プロセス不要）を
採用しました。

| | pdf-parse (採用) | anydoc | pdftotext (poppler) |
|---|---|---|---|
| 対象PDFの種類 | テキスト埋め込み型 | レイアウト複雑・スキャン画像・多様な文書形式向け（LLM/vision活用） | テキスト埋め込み型 |
| 実行環境 | npmのみで完結 | 追加ランタイム/APIキー等が必要になりうる | poppler-utilsのインストールが必要 |
| 速度・コスト | 高速・無料 | 重め・場合により有料API | 高速・無料 |
| 今回のPDFとの適合 | ◎（実物検証済み、綺麗にテキストが取れる） | 過剰（このPDF群は素のテキスト抽出で十分） | ◎（同等の代替候補） |

今回の実物検証で、サンプルPDFはいずれも **スキャン画像ではなく、テキストとして
問題なく抽出できる** ことを確認済みです（ページ境界のノイズはあるが、文字自体は
正しく取れている）。したがって「PDFからテキストを取り出す」こと自体は容易で、
本当に難しいのは「取り出したテキストのどこが賞名でどこが本文か」を判定する部分であり、
そこは高機能な文書変換ツールではなく **LLMによる構造化** で解決するのが筋が良いです。

### OCRフォールバックについて

古い年度のPDFが「本文を画像としてスキャンしたもの」である可能性は残ります。
そのため本プログラムは、抽出テキストが極端に短い（既定200文字未満）ファイルを
自動的に `extraction_status = 'needs_ocr'` としてDBに記録し、**LLM抽出には回さず
スキップ** します（無駄なAPI呼び出しを避けるため）。この `needs_ocr` 件数を
後で確認し、該当ファイルだけ anydoc や Tesseract 等のOCRツールに回す、という
二段構えの運用を想定しています（このプログラム自体にはOCR実装は含めていません）。

## LLMによる構造化抽出について

`src/extractFields.js` にプロンプトがあります。OpenAI互換の `/chat/completions`
エンドポイントを `.env` で指定するだけで、OpenAI本家以外（Azure OpenAI互換proxy、
ローカルLLM等）にも差し替え可能です。

設計上のポイント:

- 本文 (`body`) は **一切要約・言い換えをせず、原文ママ抽出する** ようプロンプトで
  明示しています（後続のクラスタリング等で原文の表現が保持されている必要があるため）。
- 抽出結果は `zod` でスキーマ検証し、壊れたJSONが返ってきた場合はリトライ、
  それでも失敗すれば `extraction_status = 'error'` として理由と共にDBに記録し、
  **バッチ全体を止めずに処理を継続** します。
- LLMが自信のない箇所は `notes` に書かせ、`extraction_notes` に保存します。
  抽出後は `extraction_status != 'ok'` の行だけを狙って目視レビューできます。
- コスト面: 44回分・数千ファイルになりうる想定のため、
  - 既に処理済み（`source_file` が同じ & PDFのSHA256ハッシュが同一 & 前回成功）の
    ファイルは自動的にスキップします（再実行してもAPIを叩き直しません）。
  - `--limit N` で少数ファイルだけ試してからフルバッチを流せます。
  - `--concurrency` でLLM呼び出しの並列数を調整できます（レート制限対策）。

## セットアップ

```bash
cd essay-extractor
npm install
cp .env.example .env
# .env を編集して OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL を設定
```

受賞作文PDFは以下のようなディレクトリ構成で配置してください（既にお手元にある構成と
同じはずです）。

```
essays/
  2023/
    001457824.pdf
    ...
  2010/
    sakubun10.pdf
    ...
```

## 実行方法

```bash
# まずは少数ファイルで試す
node src/index.js --root /path/to/essays --db essays.sqlite3 --limit 5

# 本番実行（Markdownも併せて出力する場合）
node src/index.js --root /path/to/essays --db essays.sqlite3 --export-markdown ./markdown_out

# 抽出結果をDBに書かず標準出力で確認したいだけの場合
node src/index.js --root /path/to/essays --dry-run --limit 3

# 何らかの理由で再抽出したい場合（プロンプト改善後の再処理など）
node src/index.js --root /path/to/essays --db essays.sqlite3 --force
```

オプション一覧は `node src/index.js --help` でも確認できます。

### APIキーなしで配線だけ確認したい場合

`test/mock_openai_server.js` に、実際のLLMを呼ばずJSONの形だけ模倣するモックサーバーを
同梱しています（抽出精度の検証用ではなく、CLI一式が最後まで動くかの確認用です）。

```bash
node test/mock_openai_server.js &
OPENAI_BASE_URL=http://localhost:4599/v1 OPENAI_API_KEY=dummy OPENAI_MODEL=mock \
  node src/index.js --root /path/to/essays --db test.sqlite3
```

## DBスキーマ概要（`src/db.js`）

`essays` テーブル: `year, award_name, title, prefecture, school, grade_text, grade_num,
author_name, author_kana, body, char_count, source_file, file_sha256, raw_text,
extraction_model, extraction_status, extraction_notes, created_at, updated_at`

- `raw_text`（pdf-parseの生抽出結果）も保存しているので、プロンプトを改善した際に
  PDFを再度開かずLLM抽出だけをやり直すことも可能です（現状のCLIはPDFから再実行しますが、
  `raw_text` 列を使えばLLM呼び出しだけの再実行スクリプトも簡単に書けます）。
- `extraction_status` は `ok / needs_review(未実装・拡張ポイント) / needs_ocr / error` を
  取り得ます。集計の際は基本的に `ok` のみを対象にし、それ以外は別途レビューする運用を
  想定しています。
- `essay_embeddings` テーブルを同梱済みです。後続でLLM埋め込みを計算した際、
  `essay_id / model / dim / vector(BLOB)` の形でそのまま保存できます
  （類似検索には [sqlite-vec](https://github.com/asg017/sqlite-vec) 拡張の追加導入も
  可能です）。

## 制限事項・今後の拡張候補

- 都道府県名の表記ゆれ（「東京都」等の正規化）はLLMにある程度委ねていますが、
  完全な保証はありません。集計前に `SELECT DISTINCT prefecture FROM essays` で
  ゆれを目視確認することを推奨します。
- 賞のランク付け（最優秀賞・優秀賞・佳作…の序列）が必要であれば、`award_name` から
  別途マスタテーブルで正規化するのが良いでしょう（現状は文字列のまま格納）。
- スキャン画像PDF（`needs_ocr`）への対応は本プログラムのスコープ外です。
  該当件数を見て、必要であれば anydoc やOCR専用ツールを個別に組み込んでください。
