import http from 'node:http';

// ごく単純なヒューリスティックで JSON を組み立てるだけのモック。
// 実際の抽出精度の検証ではなく、CLI〜LLM呼び出し〜DB書き込みまでの配線確認用。
function fakeExtract(rawText) {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const awardLine = lines.find((l) => l.includes('賞'));
  const gradeLine = lines.find((l) => /[１２３1-3]\s*年/.test(l));
  return {
    award_name: awardLine ?? null,
    title: lines[0] ?? null,
    prefecture: (lines.join(' ').match(/([^\s、。]+[都道府県])/) || [])[1] ?? null,
    school: null,
    grade_text: gradeLine ?? null,
    grade_num: gradeLine ? Number(gradeLine.replace(/[^0-9１２３]/g, '').replace('１', '1').replace('２', '2').replace('３', '3')) || null : null,
    author_name: null,
    author_kana: null,
    body: rawText,
    notes: 'mock server output for wiring test only',
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const userMsg = payload.messages.find((m) => m.role === 'user')?.content ?? '';
    const fields = fakeExtract(userMsg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(fields) } }],
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const PORT = 4599;
server.listen(PORT, () => console.log(`mock server on http://localhost:${PORT}/v1`));
