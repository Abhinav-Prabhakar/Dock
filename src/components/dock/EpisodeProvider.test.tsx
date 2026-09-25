import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { API_BASE } from "@/lib/api";
import type { EpisodeDescriptor, EpisodeSnapshot, Metrics } from "@/lib/api";
import { EpisodeProvider, useEpisode } from "./EpisodeProvider";

/* ---------- fake WebSocket ---------- */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  static latest() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

/* ---------- fetch router ---------- */

const okRes = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => body,
});
const errRes = (status: number, body: unknown, statusText = "Error") => ({
  ok: false,
  status,
  statusText,
  json: async () => body,
});

const METRICS: Metrics = {
  cum_revenue: 1000,
  cum_profit: 500,
  teu_booked: 100,
  utilization: 0.8,
  requests: 10,
  accepted: 8,
  rejected: 1,
  countered: 1,
  counter_won: 1,
  fuel_tonnes: 10,
  co2_tonnes: 30,
  costs: {
    fuel: 1,
    carbon: 1,
    port_fees: 1,
    demurrage: 1,
    reposition: 1,
    lease: 1,
    roll_comp: 1,
  },
};

const RUNNING: EpisodeDescriptor = {
  id: "ep-1",
  policy: "ppo",
  scenario: "baseline",
  seed: 7,
  horizon_days: 90,
  speed_days_per_sec: 4,
  status: "running",
  day: 0,
  error: null,
  n_events: 0,
  n_deals: 0,
  created_at: 0,
};

const SNAPSHOT: EpisodeSnapshot = {
  id: "ep-1",
  policy: "ppo",
  scenario: "baseline",
  status: "running",
  day: 0,
  metrics: METRICS,
  vessels: [],
  empties: {},
};

// Mutable so individual tests can steer the router.
let episodesList: EpisodeDescriptor[] = [];
let snapshotBody: EpisodeSnapshot = SNAPSHOT;
let postHandler: () => ReturnType<typeof okRes> | ReturnType<typeof errRes> = () =>
  okRes({ ...RUNNING, id: "ep-2" });
let healthOk = true;
let postedBodies: unknown[] = [];

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.endsWith("/health")) {
    if (!healthOk) throw new Error("conn refused");
    return okRes({ ok: true });
  }
  if (url.endsWith("/policies")) return okRes([]);
  if (url.endsWith("/scenarios")) return okRes([]);
  if (url.endsWith("/ports")) return okRes([]);
  if (url.endsWith("/vessels")) return okRes([]);
  if (url.endsWith("/routes")) return okRes([]);
  if (url.endsWith("/episodes") && method === "POST") {
    postedBodies.push(JSON.parse(String(init?.body)));
    return postHandler();
  }
  if (url.endsWith("/episodes")) return okRes(episodesList);
  if (url.endsWith("/deals")) return okRes([]);
  if (/\/episodes\/[^/]+$/.test(url)) return okRes(snapshotBody);
  return errRes(404, { detail: `no route ${url}` }, "Not Found");
});

/* ---------- probe ---------- */

const START_PARAMS = {
  policy: "ppo",
  scenario: "baseline",
  seed: 7,
  horizon_days: 90,
  speed_days_per_sec: 4,
};

function Probe() {
  const ctx = useEpisode();
  return (
    <div>
      <span data-testid="backendUp">{String(ctx.backendUp)}</span>
      <span data-testid="episode">
        {ctx.episode ? `${ctx.episode.id}:${ctx.episode.status}:d${ctx.episode.day}` : "none"}
      </span>
      <span data-testid="profit">{ctx.metrics ? ctx.metrics.cum_profit : "null"}</span>
      <span data-testid="series">{JSON.stringify(ctx.profitSeries)}</span>
      <span data-testid="ws">{String(ctx.wsConnected)}</span>
      <span data-testid="error">{ctx.error ?? "none"}</span>
      <button data-testid="start" onClick={() => void ctx.start(START_PARAMS)}>
        start
      </button>
    </div>
  );
}

const renderProvider = () =>
  render(
    <EpisodeProvider>
      <Probe />
    </EpisodeProvider>,
  );

const wsStreamUrl = (id: string) =>
  `${API_BASE.replace(/^http/, "ws")}/episodes/${id}/stream`;

const text = (id: string) => screen.getByTestId(id).textContent;

/* ---------- tests ---------- */

describe("EpisodeProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    episodesList = [];
    snapshotBody = SNAPSHOT;
    postHandler = () => okRes({ ...RUNNING, id: "ep-2" });
    healthOk = true;
    postedBodies = [];
    fetchMock.mockClear();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("boots: health check, reference data, no episode when none is live", async () => {
    renderProvider();
    await waitFor(() => expect(text("backendUp")).toBe("true"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(text("episode")).toBe("none");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(text("error")).toBe("none");
  });

  it("flags the backend as down when /health fails", async () => {
    healthOk = false;
    renderProvider();
    await waitFor(() => expect(text("backendUp")).toBe("false"));
    expect(text("episode")).toBe("none");
  });

  it("adopts a running episode and opens its WS stream", async () => {
    episodesList = [RUNNING];
    renderProvider();
    await waitFor(() => expect(text("episode")).toBe("ep-1:running:d0"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.latest().url).toBe(wsStreamUrl("ep-1"));
    act(() => FakeWebSocket.latest().open());
    expect(text("ws")).toBe("true");
  });

  it("a pushed day.summary updates metrics, profitSeries and day", async () => {
    episodesList = [RUNNING];
    renderProvider();
    await waitFor(() => expect(text("episode")).toBe("ep-1:running:d0"));
    const ws = FakeWebSocket.latest();
    act(() =>
      ws.emit({
        seq: 1,
        day: 5,
        type: "day.summary",
        cum_profit: 123456,
        cum_revenue: 999,
      }),
    );
    expect(text("profit")).toBe("123456");
    expect(text("series")).toBe('[{"day":5,"cum_profit":123456}]');
    expect(text("episode")).toBe("ep-1:running:d5");

    // same day pushed again → not appended twice
    act(() =>
      ws.emit({ seq: 2, day: 5, type: "day.summary", cum_profit: 200000 }),
    );
    expect(text("series")).toBe('[{"day":5,"cum_profit":123456}]');
  });

  it("episode.end flips the episode status to completed", async () => {
    episodesList = [RUNNING];
    // once the episode leaves the live state the provider re-polls the
    // snapshot — return a completed snapshot so the status sticks
    snapshotBody = { ...SNAPSHOT, status: "completed" };
    renderProvider();
    // the adoption snapshot already reports "completed" — wait for any attach
    await waitFor(() => expect(text("episode")).toMatch(/^ep-1:/));
    act(() =>
      FakeWebSocket.latest().emit({
        seq: 9,
        day: 90,
        type: "episode.end",
        status: "completed",
      }),
    );
    await waitFor(() => expect(text("episode")).toBe("ep-1:completed:d0"));
  });

  it("start() POSTs the params and attaches to the new episode", async () => {
    renderProvider();
    await waitFor(() => expect(text("backendUp")).toBe("true"));
    await act(async () => {
      screen.getByTestId("start").click();
    });
    await waitFor(() => expect(text("episode")).toBe("ep-2:running:d0"));
    expect(postedBodies).toEqual([START_PARAMS]);
    expect(FakeWebSocket.latest().url).toBe(wsStreamUrl("ep-2"));
  });

  it("409 on start adopts the already-running episode and sets an error", async () => {
    renderProvider();
    await waitFor(() => expect(text("backendUp")).toBe("true"));
    // backend now reports a live episode; POST returns 409
    episodesList = [{ ...RUNNING, id: "ep-9" }];
    postHandler = () => errRes(409, { detail: "an episode is already running" });
    await act(async () => {
      screen.getByTestId("start").click();
    });
    await waitFor(() => expect(text("episode")).toBe("ep-9:running:d0"));
    expect(text("error")).toBe("An episode was already running — attached to it.");
    expect(FakeWebSocket.latest().url).toBe(wsStreamUrl("ep-9"));
  });

  it("non-409 start failures surface the error message", async () => {
    renderProvider();
    await waitFor(() => expect(text("backendUp")).toBe("true"));
    postHandler = () => errRes(500, { detail: "engine exploded" });
    await act(async () => {
      screen.getByTestId("start").click();
    });
    await waitFor(() => expect(text("error")).toBe("engine exploded"));
    expect(text("episode")).toBe("none");
  });
});
