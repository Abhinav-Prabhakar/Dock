import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { useEpisode } from "@/components/dock/EpisodeProvider";
import type { ShockData, SummaryPolicy, TimelineDay } from "@/lib/api";

type Ctx = ReturnType<typeof useEpisode>;

const mocks = vi.hoisted(() => ({
  ctx: {} as unknown,
  getCompare: vi.fn(),
}));

vi.mock("@/components/dock/EpisodeProvider", () => ({
  useEpisode: () => mocks.ctx,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, getCompare: mocks.getCompare } };
});

import { ShockReplay } from "./ShockReplay";

const baseCtx = (over: Partial<Ctx> = {}): Ctx =>
  ({
    backendUp: true,
    policies: [],
    scenarios: [],
    ports: [],
    vessels: [],
    routes: [],
    episode: null,
    metrics: null,
    profitSeries: [],
    events: [],
    deals: [],
    snapshot: null,
    wsConnected: false,
    starting: false,
    error: null,
    start: vi.fn(async () => {}),
    control: vi.fn(async () => {}),
    dismissError: vi.fn(),
    ...over,
  }) as Ctx;

/* ---------- fixtures ---------- */

const days = (base: number): TimelineDay[] =>
  [1, 30, 45, 60, 90].map((day, i) => ({
    day,
    cum_revenue: base * (i + 1) * 2,
    cum_profit: base * (i + 1),
    utilization: 0.7 + i * 0.03,
    teu_booked: 1000 * (i + 1),
    empty_teu_nm: 1e6,
    mean_bid_pressure: null,
  }));

// shock export summaries arrive as plain numbers — cast a partial shape
const summary = (over: Record<string, unknown>): SummaryPolicy =>
  over as unknown as SummaryPolicy;

const SHOCK: ShockData = {
  event: {
    port: "NLRTM",
    day_lo: 30,
    day_hi: 45,
    description: "Rotterdam terminal closed by crane collapse",
  },
  runs: {
    static: {
      daily: days(1e6),
      summary: summary({ profit_usd: 9e6, utilization: 0.72, accepted: 610 }),
    },
    ppo: {
      daily: days(1.4e6),
      summary: summary({ profit_usd: 14e6, utilization: 0.81, accepted: 540 }),
    },
  },
};

beforeEach(() => {
  mocks.ctx = baseCtx();
  mocks.getCompare.mockReset();
  mocks.getCompare.mockResolvedValue(SHOCK);
});

/* ---------- tests ---------- */

describe("ShockReplay", () => {
  it("renders the canned shock export: banner, legend, delta chips", async () => {
    render(<ShockReplay />);
    expect(await screen.findByText(/NLRTM closure/)).toBeInTheDocument();
    expect(screen.getByText(/d30–45/)).toBeInTheDocument();
    expect(screen.getByText(/Rotterdam terminal closed/)).toBeInTheDocument();
    // delta chips: ppo − static = +$5.0M profit, +9.0pp util
    expect(screen.getByText(/Δ profit \+\$5\.0M/)).toBeInTheDocument();
    expect(screen.getByText(/\+9\.0pp/)).toBeInTheDocument();
    expect(mocks.getCompare).toHaveBeenCalledWith("shock");
  });

  it("shows the unavailable state when the export fetch fails", async () => {
    mocks.getCompare.mockRejectedValue(new Error("offline"));
    render(<ShockReplay />);
    expect(
      await screen.findByText(/shock export unavailable/),
    ).toBeInTheDocument();
  });

  it("'run it live' starts a static replay episode on volatile-shocks", async () => {
    const start = vi.fn(async () => {});
    mocks.ctx = baseCtx({ start });
    render(<ShockReplay />);
    await screen.findByText(/NLRTM closure/);
    fireEvent.click(screen.getByRole("button", { name: /run it live/ }));
    await vi.waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        policy: "static",
        scenario: "volatile-shocks",
        seed: 42,
        horizon_days: 90,
        speed_days_per_sec: 0,
      }),
    );
  });

  it("disables 'run it live' when the backend is down or an episode is live", async () => {
    mocks.ctx = baseCtx({ backendUp: false });
    render(<ShockReplay />);
    await screen.findByText(/NLRTM closure/);
    expect(
      screen.getByRole("button", { name: /run it live/ }),
    ).toBeDisabled();
  });
});
