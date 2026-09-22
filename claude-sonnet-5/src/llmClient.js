/**
 * OpenAI互換の Chat Completions エンドポイント（/v1/chat/completions）を叩く薄いクライアント。
 * OpenAI本家に限らず、Azure OpenAI互換プロキシ・ローカルLLM(vLLM/Ollama等)・その他
 * OpenAI互換APIを提供するベンダーであれば OPENAI_BASE_URL を変えるだけで差し替え可能。
 */
export async function chatComplete({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0,
  jsonMode = true,
  timeoutMs = 60_000,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages,
        // response_format はプロバイダによっては未対応。未対応でも動くよう呼び出し側で
        // フェンス除去のフォールバックパースを行う。
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('LLM API returned empty content');
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/** ```json ... ``` のようなフェンスやモデルの前置き文を除去してJSONパースを試みる */
export function parseJsonLoose(text) {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(s);
}
