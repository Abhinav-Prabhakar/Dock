interface ChatRequestBody {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages?: { role: string; content: string }[];
}

const VALID_ROLES = new Set(["system", "user", "assistant"]);

function errorResponse(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const baseUrl = body.baseUrl?.trim().replace(/\/+$/, "");
  const apiKey = body.apiKey?.trim();
  const model = body.model?.trim();
  const messages = body.messages;

  if (!baseUrl) return errorResponse(400, "Missing baseUrl");
  if (!/^https?:\/\//.test(baseUrl))
    return errorResponse(400, "baseUrl must be an http(s) URL");
  if (!apiKey) return errorResponse(400, "Missing API key — configure it via the mic hold gesture");
  if (!model) return errorResponse(400, "Missing model name");
  if (!Array.isArray(messages) || messages.length === 0)
    return errorResponse(400, "Missing messages");
  if (
    messages.some(
      (m) =>
        !m ||
        typeof m.content !== "string" ||
        !VALID_ROLES.has(m.role),
    )
  )
    return errorResponse(400, "Malformed messages");

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError")
      return errorResponse(499, "Request aborted");
    if (err instanceof DOMException && err.name === "TimeoutError")
      return errorResponse(504, "Upstream request timed out");
    return errorResponse(
      502,
      `Could not reach ${baseUrl} — ${err instanceof Error ? err.message : "network error"}`,
    );
  }

  if (!upstream.ok) {
    let message = `Upstream error (HTTP ${upstream.status})`;
    try {
      const data = await upstream.json();
      const m = data?.error?.message ?? data?.error ?? data?.message;
      if (typeof m === "string") message = m;
    } catch {
      try {
        const text = await upstream.text();
        if (text) message = text.slice(0, 500);
      } catch {
        /* keep default */
      }
    }
    return errorResponse(upstream.status, message);
  }

  if (!upstream.body) return errorResponse(502, "Upstream returned no body");

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
