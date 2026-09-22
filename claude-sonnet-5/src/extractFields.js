import { z } from 'zod';
import { chatComplete, parseJsonLoose } from './llmClient.js';

// LLMの出力形式。null許容にしておき、取得できなかった項目は null のまま保存する
// （後工程で「欠損」として扱えるようにするため、空文字で埋めない）。
export const EssayFieldsSchema = z.object({
  award_name: z.string().nullable(),
  title: z.string().nullable(),
  prefecture: z.string().nullable(),
  school: z.string().nullable(),
  grade_text: z.string().nullable(),
  grade_num: z.number().int().min(1).max(3).nullable(),
  author_name: z.string().nullable(),
  author_kana: z.string().nullable(),
  body: z.string().nullable(),
  notes: z.string().nullable().optional(),
});

const SYSTEM_PROMPT = `あなたは、全国中学生人権作文コンテストの受賞作品PDFから機械的に抽出された
テキストを整形し、構造化データに変換するアシスタントです。

入力テキストは PDF からページ順に抽出したもので、以下のようなノイズが混入しています。
このノイズを取り除きながら項目を抽出してください。

- ページの区切り付近に「第◯◯回全国中学生人権作文コンテスト」「（賞名）」のような
  大会名・賞名のバナーが、本文の途中に挿入されてしまっている（ページ送りの際の
  ヘッダー/フッターが本文の間に紛れ込んだもの）。これは本文ではないので取り除くこと。
- ページ番号、余分な空行、単語間の不自然なタブ文字・全角スペースが混じることがある。
- 賞名・タイトル・都道府県/学校/学年/氏名の記載順序や区切り方（スペース区切り、
  「・」区切りなど）は年度やファイルによって異なる。決め打ちせず、テキスト全体から
  該当箇所を判断すること。

抽出する項目:
- award_name: 受賞した賞の名前（例: 「法務事務次官賞」「最優秀賞」など）。書かれていなければ null。
- title: 作文のタイトル。
- prefecture: 筆者の居住都道府県（例: 「宮崎県」）。学校名に含まれる場合はそこから分離すること。
- school: 筆者の所属学校名（都道府県名は含めない）。
- grade_text: 学年の元の表記（例: 「３年」）。
- grade_num: 学年を 1〜3 の整数に正規化したもの。
- author_name: 筆者の氏名（漢字表記）。
- author_kana: 氏名のふりがな（括弧内などにあれば）。無ければ null。
- body: 本文のみ。ヘッダー/フッターのノイズを除去し、改行はできるだけ自然な段落として
  つなげてよいが、本文の語順・語句・句読点は一切変更・要約・言い換えをしないこと。
  一字一句、原文のままにすること。
- notes: 抽出結果に自信が持てない点や、欠損している項目があれば簡潔に記す。問題なければ null。

出力は必ず次のキーのみを持つ JSON オブジェクト一つだけとし、それ以外の文章は一切出力しないこと:
award_name, title, prefecture, school, grade_text, grade_num, author_name, author_kana, body, notes
`;

/**
 * PDFから抽出した生テキストを渡し、構造化フィールドを得る。
 * @param {object} opts
 * @param {string} opts.rawText
 * @param {{baseUrl:string, apiKey:string, model:string}} opts.llm
 * @param {number} [opts.maxRetries]
 */
export async function extractFieldsWithLLM({ rawText, llm, maxRetries = 2 }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const content = await chatComplete({
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        model: llm.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: rawText },
        ],
      });
      const json = parseJsonLoose(content);
      const parsed = EssayFieldsSchema.parse(json);
      return { ok: true, fields: parsed, rawResponse: content };
    } catch (err) {
      lastErr = err;
      // 429/一時的なエラーの可能性があるので軽く待ってリトライ
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { ok: false, error: String(lastErr?.message ?? lastErr) };
}
