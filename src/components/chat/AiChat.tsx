"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowUpRight,
  Box,
  Loader2,
  Mic,
  Plus,
  RotateCcw,
  Ship,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  loadLlmConfig,
  streamChat,
  withBackoff,
  type ChatMessage,
  type LlmConfig,
} from "@/lib/llm";
import { bayRows, sidebarContainers } from "@/lib/data";
import { ApiSettingsDialog } from "./ApiSettingsDialog";

/* ---------------------------------- types --------------------------------- */

type MsgStatus = "pending" | "streaming" | "done" | "error" | "stopped";

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MsgStatus;
  error?: string;
  schematic?: boolean;
}

type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

const HOLD_MS = 2500;

const SEED_REPLY =
  "Current container layout on LYN-01 shows a left-heavy imbalance, particularly around Platforms B2 and C1. To optimize loading efficiency and reduce tilt risk, consider shifting CNT-C14 and CNT-C09 to central bays.";

function vesselSnapshot(): string {
  const cells = bayRows
    .flat()
    .filter((c) => c.id)
    .map((c) => `${c.id} (${c.serial}, ${c.status})`)
    .join(", ");
  const flagged = sidebarContainers
    .map((c) => `${c.id}: platform ${c.platform}, ${c.status}, ${c.weight}t`)
    .join("; ");
  return `Vessel LYN-01 bay plan: ${cells}. Monitored containers: ${flagged}. Loading flow 161.35 t/h, load imbalance 13% (port 54% / starboard 42%).`;
}

const SYSTEM_PROMPT =
  "You are the Arvion Dock Operations assistant embedded in a container-vessel loading console. Answer concisely (2–4 short paragraphs max) with concrete, operational recommendations about stowage, weight distribution, platforms and container IDs. Reference the vessel snapshot when relevant. Plain text only, no markdown.";

let uid = 0;
const nextId = () => `m${++uid}-${Date.now()}`;

/* ------------------------- vessel side-view blueprint ------------------------ */

function SideViewSchematic() {
  const line = "rgba(178,188,240,0.55)";
  const faint = "rgba(178,188,240,0.24)";
  const ghost = "rgba(178,188,240,0.13)";
  const colors = { red: "#e0566b", yellow: "#d9b13b", teal: "#3fbdb0" };

  // A stack of outlined container cells above the deck line (deck at y=58).
  const stack = (x: number, w: number, cells: (keyof typeof colors | null)[]) =>
    cells.map((c, i) => (
      <rect
        key={`${x}-${i}`}
        x={x}
        y={56 - (i + 1) * 8.5}
        width={w}
        height={7.5}
        rx="0.75"
        stroke={c ? colors[c] : ghost}
        strokeWidth={c ? 0.9 : 0.7}
        fill={c ? colors[c] : "none"}
        fillOpacity={c ? 0.08 : 0}
      />
    ));

  return (
    <svg viewBox="0 0 320 104" className="h-auto w-full" fill="none" aria-hidden>
      {/* faint construction grid */}
      {[30, 42].map((y) => (
        <line key={y} x1="16" y1={y} x2="308" y2={y} stroke={ghost} strokeWidth="0.5" strokeDasharray="3 4" />
      ))}
      {[66, 104, 142, 180, 218].map((x) => (
        <line key={x} x1={x} y1="8" x2={x} y2="56" stroke={ghost} strokeWidth="0.5" />
      ))}
      {/* lashing-bridge ticks along the hold line */}
      {Array.from({ length: 24 }, (_, i) => (
        <line key={`t${i}`} x1={56 + i * 6.6} y1={56} x2={56 + i * 6.6} y2={59.5} stroke={faint} strokeWidth="0.5" />
      ))}

      {/* hull */}
      <path
        d="M12 50 L19 61 Q21 67 30 67 L270 67 Q286 67 294 57 L298 48"
        stroke={line}
        strokeWidth="1"
      />
      <path d="M12 50 L298 48" stroke={faint} strokeWidth="0.75" />
      <path d="M12 50 L32 48" stroke={faint} strokeWidth="0.75" />
      {/* inner hull strakes */}
      <path d="M22 62 L268 62" stroke={ghost} strokeWidth="0.6" />
      <path d="M40 67 L44 74 Q46 78 54 78 L262 78" stroke={ghost} strokeWidth="0.6" />
      {/* bulbous bow / anchor detail */}
      <circle cx="26" cy="73" r="3" stroke={faint} strokeWidth="0.75" />
      <line x1="26" y1="67" x2="26" y2="70" stroke={faint} strokeWidth="0.75" />
      <line x1="18" y1="56" x2="24" y2="61" stroke={ghost} strokeWidth="0.6" />

      {/* keel ticks */}
      {Array.from({ length: 17 }, (_, i) => (
        <line key={i} x1={50 + i * 13.5} y1={78} x2={50 + i * 13.5} y2={81.5} stroke={ghost} strokeWidth="0.5" />
      ))}

      {/* cargo holds — outlined container stacks */}
      {stack(56, 14, ["red", "yellow", "teal", null])}
      {stack(73, 14, ["yellow", null, "red", "teal"])}
      {stack(90, 14, [null, "teal", "yellow", "red"])}
      {stack(107, 14, ["red", null, "yellow", null])}
      {stack(124, 14, ["yellow", "teal", null, "yellow"])}
      {stack(141, 14, [null, "red", "teal", null])}
      {stack(158, 14, ["teal", "yellow", "red", "teal"])}
      {stack(175, 14, [null, "teal", "yellow", "red"])}
      {stack(192, 14, ["yellow", null, "teal", null])}
      {/* hatch coaming frame */}
      {[52, 210].map((x) => (
        <line key={x} x1={x} y1="16" x2={x} y2="56" stroke={faint} strokeWidth="0.75" />
      ))}
      <line x1="52" y1="16" x2="210" y2="16" stroke={faint} strokeWidth="0.75" />
      <line x1="52" y1="20" x2="210" y2="20" stroke={ghost} strokeWidth="0.5" strokeDasharray="2 3" />

      {/* superstructure / castle */}
      <rect x="234" y="22" width="40" height="36" rx="1.5" stroke={line} strokeWidth="1" />
      {[29, 36, 43, 50].map((y) => (
        <line key={y} x1="236" y1={y} x2="272" y2={y} stroke={faint} strokeWidth="0.75" />
      ))}
      <rect x="243" y="15" width="22" height="7" rx="1" stroke={line} strokeWidth="0.9" />
      <rect x="247" y="24" width="6" height="5" rx="0.5" stroke={faint} strokeWidth="0.7" />
      <line x1="254" y1="4" x2="254" y2="15" stroke={line} strokeWidth="0.9" />
      <line x1="248" y1="7" x2="260" y2="7" stroke={faint} strokeWidth="0.75" />
      <line x1="254" y1="4" x2="262" y2="11" stroke={ghost} strokeWidth="0.6" />
      <circle cx="254" cy="3" r="1.4" stroke={line} strokeWidth="0.75" />
      {/* funnel mark */}
      <line x1="238" y1="26" x2="244" y2="26" stroke={line} strokeWidth="1" />

      {/* engine-room / tank grid below the aft deck */}
      {Array.from({ length: 5 }, (_, r) =>
        Array.from({ length: 9 }, (_, c) => (
          <rect
            key={`${r}-${c}`}
            x={228 + c * 8}
            y={72 + r * 5.5}
            width="6.5"
            height="4.5"
            rx="0.5"
            stroke={ghost}
            strokeWidth="0.6"
          />
        )),
      )}
      {/* fore-peak detail */}
      <line x1="280" y1="50" x2="280" y2="66" stroke={faint} strokeWidth="0.6" />
      <line x1="288" y1="52" x2="288" y2="62" stroke={ghost} strokeWidth="0.6" />
    </svg>
  );
}

/* --------------------------------- messages -------------------------------- */

function MessageList({ messages }: { messages: Msg[] }) {
  return (
    <>
      {messages.map((m) => {
        if (m.role === "user") {
          return (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/25 px-3.5 py-2 text-[12px] leading-relaxed text-hi">
                {m.content}
              </p>
            </div>
          );
        }
        if (m.status === "error") {
          return (
            <div
              key={m.id}
              className="rounded-xl border border-critical/30 bg-critical/10 px-3.5 py-2.5"
            >
              <p className="text-[11.5px] leading-relaxed text-pending-soft">
                {m.error}
              </p>
            </div>
          );
        }
        return (
          <div key={m.id}>
            {m.schematic && (
              <div className="mb-3">
                <SideViewSchematic />
              </div>
            )}
            {m.status === "pending" ? (
              <p className="flex items-center gap-2 text-[11.5px] text-low">
                <Loader2 size={12} className="animate-spin" />
                {m.content}
              </p>
            ) : (
              <p className="text-[12px] leading-relaxed text-mid">
                {m.content}
                {m.status === "streaming" && (
                  <span className="ml-0.5 inline-block h-3.5 w-[1.5px] translate-y-0.5 animate-pulse bg-hi" />
                )}
                {m.status === "stopped" && (
                  <span className="ml-1.5 text-[10px] text-faint">(stopped)</span>
                )}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

/* ---------------------------------- chat ----------------------------------- */

export function AiChat() {
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);
  const [messages, setMessages] = useState<Msg[]>([
    { id: "seed", role: "assistant", content: SEED_REPLY, status: "done", schematic: true },
  ]);
  const [draft, setDraft] = useState(
    "Can you review container distribution on LYN-01 and suggest changes to improve weight",
  );
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachContext, setAttachContext] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<{ payload: ChatMessage[]; assistantId: string } | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const dictationBaseRef = useRef("");
  const holdRef = useRef<{ raf: number; start: number; fired: boolean } | null>(null);
  const clickGuardRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  // Auto-grow the textarea as the draft changes.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  // The Arvion sparkle button focuses the composer.
  useEffect(() => {
    const focus = () => textRef.current?.focus();
    window.addEventListener("dock:focus-composer", focus);
    return () => window.removeEventListener("dock:focus-composer", focus);
  }, []);

  const patchMsg = useCallback((id: string, patch: Partial<Msg>) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  /* --------------------------------- send ---------------------------------- */

  const runRequest = useCallback(
    async (payload: ChatMessage[], assistantId: string) => {
      abortRef.current = new AbortController();
      setBusy(true);
      let acc = "";
      try {
        const full = await withBackoff(
          () =>
            streamChat(
              config,
              payload,
              (delta) => {
                acc += delta;
                patchMsg(assistantId, { content: acc, status: "streaming" });
              },
              abortRef.current!.signal,
            ),
          {
            attempts: 4,
            baseDelay: 700,
            signal: abortRef.current.signal,
            onRetry: (attempt, delay) => {
              acc = "";
              patchMsg(assistantId, {
                status: "pending",
                content: `Retrying in ${(delay / 1000).toFixed(1)}s — attempt ${attempt + 1} of 4`,
              });
            },
          },
        );
        patchMsg(assistantId, { content: full, status: "done" });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          patchMsg(assistantId, {
            status: acc ? "stopped" : "error",
            error: acc ? undefined : "Request cancelled.",
          });
        } else {
          patchMsg(assistantId, {
            status: "error",
            error:
              err instanceof Error ? err.message : "Something went wrong.",
          });
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [config, patchMsg],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setMenuOpen(false);

    const history: ChatMessage[] = messages
      .filter((m) => m.status === "done" || m.role === "user")
      .map((m) => ({ role: m.role, content: m.content }));

    const payload: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(attachContext
        ? [{ role: "system" as const, content: `Snapshot: ${vesselSnapshot()}` }]
        : []),
      ...history,
      { role: "user", content: text },
    ];

    const userMsg: Msg = {
      id: nextId(),
      role: "user",
      content: attachContext ? `${text}\n\n· LYN-01 snapshot attached` : text,
      status: "done",
    };
    const assistantId = nextId();
    lastRequestRef.current = { payload, assistantId };
    setAttachContext(false);
    setMessages((ms) => [
      ...ms,
      userMsg,
      { id: assistantId, role: "assistant", content: "Analyzing vessel data…", status: "pending" },
    ]);
    void runRequest(payload, assistantId);
  }, [attachContext, busy, draft, messages, runRequest]);

  const retry = useCallback(() => {
    const last = lastRequestRef.current;
    if (!last || busy) return;
    patchMsg(last.assistantId, {
      status: "pending",
      content: "Retrying…",
      error: undefined,
    });
    void runRequest(last.payload, last.assistantId);
  }, [busy, patchMsg, runRequest]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /* ------------------------------ mic gestures ------------------------------ */

  const stopDictation = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const toggleDictation = useCallback(() => {
    if (listening) {
      stopDictation();
      return;
    }
    const w = window as unknown as Record<string, unknown>;
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      | (new () => RecognitionLike)
      | undefined;
    if (!Ctor) {
      setNotice("Speech recognition isn't available in this browser.");
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    dictationBaseRef.current = draft;
    rec.onresult = (e) => {
      let interim = "";
      let finals = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals += r[0].transcript;
        else interim += r[0].transcript;
      }
      const base = dictationBaseRef.current;
      setDraft(base + finals + interim);
      if (finals) dictationBaseRef.current = base + finals;
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed")
        setNotice("Microphone access was denied.");
      else if (e.error !== "aborted")
        setNotice(`Speech recognition error${e.error ? `: ${e.error}` : "."}`);
    };
    recognitionRef.current = rec;
    setNotice(null);
    try {
      rec.start();
      setListening(true);
    } catch {
      setNotice("Could not start speech recognition.");
    }
  }, [draft, listening, stopDictation]);

  const cancelHold = useCallback(() => {
    if (holdRef.current) cancelAnimationFrame(holdRef.current.raf);
    holdRef.current = null;
    setHoldProgress(0);
  }, []);

  const onMicDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const state = { raf: 0, start: performance.now(), fired: false };
      holdRef.current = state;
      const tick = (now: number) => {
        if (holdRef.current !== state) return;
        const p = Math.min((now - state.start) / HOLD_MS, 1);
        setHoldProgress(p);
        if (p >= 1) {
          state.fired = true;
          holdRef.current = null;
          setHoldProgress(0);
          setSettingsOpen(true);
          return;
        }
        state.raf = requestAnimationFrame(tick);
      };
      state.raf = requestAnimationFrame(tick);
    },
    [],
  );

  const onMicUp = useCallback(() => {
    const state = holdRef.current;
    cancelHold();
    clickGuardRef.current = Date.now();
    if (state && !state.fired) toggleDictation();
  }, [cancelHold, toggleDictation]);

  // Keyboard activation (Enter/Space) fires click without pointer events.
  const onMicClick = useCallback(() => {
    if (Date.now() - clickGuardRef.current < 400) return;
    toggleDictation();
  }, [toggleDictation]);

  /* ------------------------------ plus menu -------------------------------- */

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const seedDraft =
    "Can you review container distribution on LYN-01 and suggest changes to improve weight";

  /* ---------------------------------- render -------------------------------- */

  const lastError = [...messages].reverse().find((m) => m.status === "error");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Cargo Optimizer — messages card */}
      <div className="panel-flat flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px]">
        <div className="px-4 pt-3.5">
          <h2 className="font-display text-[14px] font-medium text-hi">
            Cargo Optimizer
          </h2>
          <div className="mt-2.5 flex items-center gap-3.5 text-[10px] text-low">
            <span className="flex items-center gap-1.5">
              <Box size={11} className="text-pending" strokeWidth={1.75} />{" "}
              Pending
            </span>
            <span className="flex items-center gap-1.5">
              <Box size={11} className="text-reserved" strokeWidth={1.75} />{" "}
              Reserved
            </span>
            <span className="flex items-center gap-1.5">
              <Box size={11} className="text-loaded" strokeWidth={1.75} /> Loaded
            </span>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 [scrollbar-width:thin]"
        >
          <MessageList messages={messages} />
          {lastError && (
            <button
              onClick={retry}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full border hairline px-3 py-1.5 text-[10.5px] text-mid transition-colors hover:text-hi disabled:opacity-50"
            >
              <RotateCcw size={11} strokeWidth={1.75} /> Retry request
            </button>
          )}
        </div>
      </div>

      {/* notice bar */}
      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-xl border hairline bg-panel px-3 py-2">
          <p className="text-[10.5px] leading-snug text-mid">{notice}</p>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 text-low transition-colors hover:text-hi"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* composer — pinned at bottom of the flex column */}
      <div className="relative mt-auto shrink-0">
        <div className="relative overflow-hidden rounded-[22px] border hairline bg-panel-2/80">
          {attachContext && (
            <div className="relative flex items-center gap-1.5 px-3.5 pt-3">
              <span className="flex items-center gap-1.5 rounded-full bg-accent/25 px-2.5 py-1 text-[10px] text-hi">
                <Ship size={10} strokeWidth={1.75} /> LYN-01 snapshot attached
                <button
                  onClick={() => setAttachContext(false)}
                  aria-label="Remove vessel context"
                  className="ml-0.5 text-white/60 transition-colors hover:text-white"
                >
                  <X size={10} />
                </button>
              </span>
            </div>
          )}
          <textarea
            ref={textRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={3}
            placeholder="Ask about the load plan…"
            aria-label="Chat message"
            className="relative w-full resize-none bg-transparent px-4 pt-4 text-[12.5px] leading-relaxed text-hi outline-none placeholder:text-low"
          />
          <div className="relative flex items-center gap-2 px-3 pt-1 pb-3">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="More actions"
              className="flex h-9 w-9 items-center justify-center rounded-full border hairline text-mid transition-colors hover:text-hi"
            >
              <Plus size={16} strokeWidth={1.75} />
            </button>

            <div className="ml-auto flex items-center gap-2">
              {/* mic — tap to dictate, hold 2.5s for API settings */}
              <button
                onPointerDown={onMicDown}
                onPointerUp={onMicUp}
                onClick={onMicClick}
                onPointerLeave={cancelHold}
                onPointerCancel={cancelHold}
                onContextMenu={(e) => e.preventDefault()}
                aria-label="Voice input — hold for API settings"
                className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                  listening
                    ? "bg-critical/25 text-pending-soft"
                    : "bg-panel-3 text-mid hover:text-hi"
                }`}
              >
                <svg
                  viewBox="0 0 36 36"
                  className="absolute inset-0 h-full w-full -rotate-90"
                  aria-hidden
                >
                  <circle
                    cx="18"
                    cy="18"
                    r="16.5"
                    fill="none"
                    stroke="rgba(238,240,255,0.9)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 16.5}
                    strokeDashoffset={2 * Math.PI * 16.5 * (1 - holdProgress)}
                  />
                </svg>
                <Mic size={14} strokeWidth={1.75} />
              </button>

              {busy ? (
                <button
                  onClick={stop}
                  aria-label="Stop generating"
                  className="flex h-10 w-14 items-center justify-center rounded-full bg-white text-abyss transition-colors hover:bg-white/90"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!draft.trim()}
                  aria-label="Send message"
                  className="flex h-10 w-14 items-center justify-center rounded-full bg-white text-abyss transition-all hover:bg-white/90 disabled:opacity-40"
                >
                  <ArrowUpRight size={17} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
          {/* spectrum edge — sky blue → red → yellow → green, soft upward glow */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-4 bottom-0 h-3 rounded-full bg-[linear-gradient(90deg,#5b8cff_0%,#e0566b_33%,#f0a04b_66%,#8fd16a_100%)] opacity-35 blur-[6px]"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-3 bottom-0 h-[1.5px] rounded-full bg-[linear-gradient(90deg,#5b8cff_0%,#e0566b_33%,#f0a04b_66%,#8fd16a_100%)]"
          />
        </div>

        {/* + actions popover — outside the clipped card so it can overflow */}
        {menuOpen && (
          <div
            className="panel-flat absolute bottom-14 left-2 z-20 w-52 overflow-hidden rounded-xl py-1 shadow-[0_16px_48px_rgba(2,4,18,0.6)]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setAttachContext(true);
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[11.5px] text-mid transition-colors hover:bg-white/5 hover:text-hi"
            >
              <Ship size={13} strokeWidth={1.75} /> Attach vessel snapshot
            </button>
            <button
              onClick={() => {
                setDraft(seedDraft);
                setMenuOpen(false);
                textRef.current?.focus();
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[11.5px] text-mid transition-colors hover:bg-white/5 hover:text-hi"
            >
              <Sparkles size={13} strokeWidth={1.75} /> Insert example prompt
            </button>
            <button
              onClick={() => {
                setMessages([
                  { id: "seed", role: "assistant", content: SEED_REPLY, status: "done", schematic: true },
                ]);
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[11.5px] text-mid transition-colors hover:bg-white/5 hover:text-hi"
            >
              <Trash2 size={13} strokeWidth={1.75} /> Clear conversation
            </button>
          </div>
        )}
      </div>

      <ApiSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={setConfig}
      />
    </div>
  );
}
