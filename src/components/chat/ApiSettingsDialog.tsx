"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import {
  loadLlmConfig,
  saveLlmConfig,
  testConnection,
  type LlmConfig,
} from "@/lib/llm";

const inputCls =
  "w-full rounded-xl border hairline bg-abyss/60 px-3.5 py-2.5 text-[12.5px] text-hi outline-none transition-colors placeholder:text-faint focus:border-accent/60 focus:bg-abyss/80";

export function ApiSettingsDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (config: LlmConfig) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return <DialogBody onClose={onClose} onSaved={onSaved} />;
}

function DialogBody({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (config: LlmConfig) => void;
}) {
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok" }
    | { kind: "err"; message: string }
  >({ kind: "idle" });

  const set = <K extends keyof LlmConfig>(k: K, v: LlmConfig[K]) => {
    setConfig((c) => ({ ...c, [k]: v }));
    setTestState({ kind: "idle" });
  };

  const runTest = async () => {
    setTestState({ kind: "testing" });
    try {
      await testConnection(config);
      setTestState({ kind: "ok" });
    } catch (err) {
      setTestState({
        kind: "err",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="API settings"
        className="panel-flat w-[380px] rounded-2xl p-5 shadow-[0_24px_80px_rgba(2,4,18,0.7)]"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-[15px] font-semibold text-hi">
              API Management
            </h2>
            <p className="mt-0.5 text-[10.5px] text-low">
              OpenAI-compatible chat endpoint
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="flex h-8 w-8 items-center justify-center rounded-full chip text-mid transition-colors hover:text-hi"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[10.5px] font-medium tracking-wide text-low uppercase">
              Base URL
            </span>
            <input
              className={inputCls}
              value={config.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[10.5px] font-medium tracking-wide text-low uppercase">
              API Key
            </span>
            <div className="relative">
              <input
                className={`${inputCls} pr-10`}
                type={showKey ? "text" : "password"}
                value={config.apiKey}
                onChange={(e) => set("apiKey", e.target.value)}
                placeholder="sk-…"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                aria-label={showKey ? "Hide API key" : "Show API key"}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-low transition-colors hover:text-hi"
              >
                {showKey ? (
                  <EyeOff size={14} strokeWidth={1.75} />
                ) : (
                  <Eye size={14} strokeWidth={1.75} />
                )}
              </button>
            </div>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[10.5px] font-medium tracking-wide text-low uppercase">
              Model
            </span>
            <input
              className={inputCls}
              value={config.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder="gpt-4o-mini"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>

        {testState.kind === "err" && (
          <p className="mt-3 rounded-lg border border-critical/30 bg-critical/10 px-3 py-2 text-[11px] leading-relaxed text-pending-soft">
            {testState.message}
          </p>
        )}
        {testState.kind === "ok" && (
          <p className="mt-3 flex items-center gap-1.5 rounded-lg border border-loaded/30 bg-loaded/10 px-3 py-2 text-[11px] text-loaded-soft">
            <Check size={12} strokeWidth={2.5} /> Connection successful
          </p>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={runTest}
            disabled={testState.kind === "testing"}
            className="flex h-9 items-center gap-2 rounded-full border hairline px-4 text-[11.5px] font-medium text-mid transition-colors hover:text-hi disabled:opacity-60"
          >
            {testState.kind === "testing" && (
              <Loader2 size={13} className="animate-spin" />
            )}
            Test connection
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="flex h-9 items-center rounded-full px-4 text-[11.5px] font-medium text-mid transition-colors hover:text-hi"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                saveLlmConfig(config);
                onSaved(config);
                onClose();
              }}
              className="flex h-9 items-center rounded-full bg-white px-5 text-[11.5px] font-semibold text-abyss transition-colors hover:bg-white/90"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
