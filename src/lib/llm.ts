export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};

const STORAGE_KEY = "dock.llmConfig";

export function loadLlmConfig(): LlmConfig {
  if (typeof window === "undefined") return DEFAULT_LLM_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LLM_CONFIG;
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    return {
      baseUrl: parsed.baseUrl?.trim() || DEFAULT_LLM_CONFIG.baseUrl,
      apiKey: parsed.apiKey ?? "",
      model: parsed.model?.trim() || DEFAULT_LLM_CONFIG.model,
    };
  } catch {
    return DEFAULT_LLM_CONFIG;
  }
}

export function saveLlmConfig(config: LlmConfig) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ChatError) return err.retryable;
  // Network failures (TypeError from fetch) are retryable; aborts are not.
  return err instanceof TypeError;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Exponential backoff: 700ms, 1.4s, 2.8s … + jitter, up to `attempts` total.
 * The last error is re-thrown so the UI can surface it — no silent fallback.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  {
    attempts = 4,
    baseDelay = 700,
    signal,
    onRetry,
  }: {
    attempts?: number;
    baseDelay?: number;
    signal?: AbortSignal;
    onRetry?: (attempt: number, nextDelayMs: number, err: unknown) => void;
  } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      const delay = baseDelay * 2 ** (attempt - 1) + Math.random() * 250;
      onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

interface SseChunk {
  choices?: { delta?: { content?: string } }[];
  error?: { message?: string };
}

/**
 * Calls the local /api/chat proxy and streams OpenAI-compatible deltas.
 * Throws ChatError on HTTP / upstream / malformed-stream failures.
 */
export async function streamChat(
  config: LlmConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ChatError(
      "Could not reach the chat service. Check your connection.",
      undefined,
      true,
    );
  }

  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      /* keep status message */
    }
    const retryable = res.status === 429 || res.status >= 500;
    throw new ChatError(message, res.status, retryable);
  }

  if (!res.body) throw new ChatError("Empty response stream", res.status, true);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      const data = evt
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      if (data === "[DONE]") return full;
      let chunk: SseChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // ignore keep-alives / partial JSON fragments
      }
      if (chunk.error?.message) throw new ChatError(chunk.error.message);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  }
  return full;
}

/** Non-streaming call used by the settings dialog "Test connection" button. */
export async function testConnection(config: LlmConfig): Promise<void> {
  const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) {
    let message = `Connection failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      const m = body?.error?.message ?? body?.error;
      if (typeof m === "string") message = m;
    } catch {
      /* keep status message */
    }
    throw new ChatError(message, res.status, res.status === 429 || res.status >= 500);
  }
}
