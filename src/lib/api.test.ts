import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, API_BASE, wsUrl } from "@/lib/api";

/** Build a minimal fetch Response stand-in. */
const res = (
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string; jsonFail?: boolean } = {},
) => ({
  ok: opts.ok ?? true,
  status: opts.status ?? 200,
  statusText: opts.statusText ?? "OK",
  json: opts.jsonFail
    ? async () => {
        throw new SyntaxError("Unexpected token");
      }
    : async () => body,
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchApi via api.* methods", () => {
  it("api.getHealth hits /health and returns parsed JSON", async () => {
    fetchMock.mockResolvedValueOnce(res({ ok: true }));
    await expect(api.getHealth()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/health`, undefined);
  });

  it("ApiError carries FastAPI {detail} message and status", async () => {
    fetchMock.mockResolvedValueOnce(
      res({ detail: "episode already running" }, { ok: false, status: 409 }),
    );
    const err = await api.getEpisodes().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("episode already running");
    expect(err.status).toBe(409);
  });

  it("non-JSON error body falls back to '<status> <statusText>'", async () => {
    fetchMock.mockResolvedValueOnce(
      res(null, {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        jsonFail: true,
      }),
    );
    const err = await api.getHealth().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("502 Bad Gateway");
    expect(err.status).toBe(502);
  });

  it("error body without a string detail falls back to status text", async () => {
    fetchMock.mockResolvedValueOnce(
      res({ detail: { nested: true } }, { ok: false, status: 500, statusText: "Server Error" }),
    );
    const err = await api.getHealth().catch((e) => e);
    expect(err.message).toBe("500 Server Error");
  });

  it("api.startEpisode sends POST with JSON body", async () => {
    const desc = { id: "ep-1", status: "running" };
    fetchMock.mockResolvedValueOnce(res(desc));
    const params = {
      policy: "ppo",
      scenario: "baseline",
      seed: 42,
      horizon_days: 90,
      speed_days_per_sec: 4,
    };
    await expect(api.startEpisode(params)).resolves.toEqual(desc);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/episodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  });

  it("api.getCompare builds the /compare/<name> path", async () => {
    fetchMock.mockResolvedValue(res({}));
    await api.getCompare("summary");
    await api.getCompare("meta");
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${API_BASE}/compare/summary`, undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${API_BASE}/compare/meta`, undefined);
  });

  it("api.getEpisodeDeals hits the deals endpoint", async () => {
    fetchMock.mockResolvedValueOnce(res([]));
    await api.getEpisodeDeals("ep-9");
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/episodes/ep-9/deals`, undefined);
  });
});

describe("wsUrl", () => {
  it("maps http → ws", () => {
    expect(API_BASE.startsWith("http")).toBe(true);
    expect(wsUrl("ep-1")).toBe(
      `${API_BASE.replace(/^http/, "ws")}/episodes/ep-1/stream`,
    );
    expect(wsUrl("ep-1").startsWith("ws://")).toBe(true);
  });

  it("maps https → wss (fresh module with env override)", async () => {
    const prev = process.env.NEXT_PUBLIC_DOCK_API;
    process.env.NEXT_PUBLIC_DOCK_API = "https://dock.example.com";
    try {
      vi.resetModules();
      const mod = await import("@/lib/api");
      expect(mod.API_BASE).toBe("https://dock.example.com");
      expect(mod.wsUrl("ep-2")).toBe("wss://dock.example.com/episodes/ep-2/stream");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_DOCK_API;
      else process.env.NEXT_PUBLIC_DOCK_API = prev;
      vi.resetModules();
    }
  });
});
