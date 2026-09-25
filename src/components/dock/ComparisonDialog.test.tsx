import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MetaData, SummaryData, SummaryPolicy, SummaryStats, TimelineData } from "@/lib/api";

const mocks = vi.hoisted(() => ({ getCompare: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: { getCompare: mocks.getCompare } }));

import ComparisonDialog from "./ComparisonDialog";

/* ---------- fixtures ---------- */

const stats = (mean: number, std = Math.abs(mean) * 0.05): SummaryStats => ({ mean, std });

const policy = (profitMean: number): SummaryPolicy => ({
  revenue_usd: stats(profitMean * 2.4),
  profit_usd: stats(profitMean),
  revenue_per_teu: stats(1450),
  utilization: stats(0.81),
  empty_teu_nm: stats(4.2e6),
  co2_per_teu: stats(0.42),
  fuel_tonnes: stats(900),
  counter_win_rate: stats(0.35),
  reject_to_counter_conv: stats(0.22),
  requests: stats(1200),
  accepted: stats(800),
  teu_booked: stats(40000),
  segments: {
    flexible: { requests: 300, booked: 210 },
    standard: { requests: 600, booked: 420 },
    urgent: { requests: 300, booked: 240 },
  },
});

const SUMMARY: SummaryData = {
  policies: {
    static: policy(10e6),
    greedy: policy(11e6),
    heuristic: policy(11.5e6),
    heuristic_bid: policy(12e6),
    ppo: policy(13e6),
  },
  lift_vs_static: {
    greedy: { profit_usd_pct: 0.1, revenue_per_teu_pct: 0.04, utilization_pp: 2 },
    // heuristic deliberately missing → exercises the "static ≤ 0" chip path
    heuristic_bid: { profit_usd_pct: 0.2, revenue_per_teu_pct: 0.08, utilization_pp: 4 },
    ppo: { profit_usd_pct: 0.3, revenue_per_teu_pct: 0.12, utilization_pp: 6 },
  },
};

const days = (base: number) =>
  [1, 30, 60, 90].map((day, i) => ({
    day,
    cum_revenue: base * (i + 1) * 2,
    cum_profit: base * (i + 1),
    utilization: 0.7 + i * 0.03,
    teu_booked: 1000 * (i + 1),
    empty_teu_nm: 1e6,
    mean_bid_pressure: null,
  }));

const TIMELINE: TimelineData = {
  policies: {
    static: days(1e6),
    greedy: days(1.1e6),
    heuristic: days(1.15e6),
    heuristic_bid: days(1.2e6),
    ppo: days(1.3e6),
  },
};

const META: MetaData = {
  git_sha: "abcdef1234567890",
  generated_at: "2025-01-15T00:00:00Z",
  seed: 42,
  episodes: 40,
  horizon_days: 90,
  scenarios: ["baseline"],
  policies_present: ["static", "greedy", "heuristic", "heuristic_bid", "ppo"],
  demand_model: "gravity",
  notes: "",
};

const loadOk = (meta: MetaData | null = META) =>
  mocks.getCompare.mockImplementation(async (name: string) => {
    if (name === "summary") return SUMMARY;
    if (name === "timeline") return TIMELINE;
    if (name === "meta") return meta;
    return null;
  });

beforeEach(() => {
  mocks.getCompare.mockReset();
  loadOk();
});

/* ---------- tests ---------- */

describe("ComparisonDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<ComparisonDialog open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.getCompare).not.toHaveBeenCalled();
  });

  it("renders all five policy ladder cards with names and profits", async () => {
    render(<ComparisonDialog open onClose={() => {}} />);
    // names appear both in the ladder cards and the racing-chart legend
    for (const name of [
      "Static Rate Card",
      "Greedy",
      "Heuristic",
      "Heuristic + Bid",
      "Dock · PPO",
    ]) {
      expect((await screen.findAllByText(name)).length).toBeGreaterThanOrEqual(1);
    }
    expect(screen.getByText("$13.0M")).toBeInTheDocument(); // ppo profit
    expect(screen.getByText("$10.0M")).toBeInTheDocument(); // static profit
    expect(mocks.getCompare).toHaveBeenCalledWith("summary");
    expect(mocks.getCompare).toHaveBeenCalledWith("timeline");
    expect(mocks.getCompare).toHaveBeenCalledWith("meta");
  });

  it("renders signed lift chips and the 'static ≤ 0' fallback for missing lift", async () => {
    render(<ComparisonDialog open onClose={() => {}} />);
    await screen.findAllByText("Dock · PPO");
    expect(screen.getByText("+30.0%")).toBeInTheDocument(); // ppo lift
    // heuristic has no lift_vs_static entry → fallback chip, no crash
    expect(screen.getAllByText("static ≤ 0").length).toBeGreaterThanOrEqual(1);
  });

  it("marks policies absent from meta.policies_present as n/a", async () => {
    loadOk({ ...META, policies_present: ["static", "greedy", "heuristic", "heuristic_bid"] });
    render(<ComparisonDialog open onClose={() => {}} />);
    await screen.findAllByText("Dock · PPO");
    expect(screen.getByText(/n\/a/)).toBeInTheDocument();
  });

  it("renders the meta provenance footer (seed / episodes / git sha)", async () => {
    render(<ComparisonDialog open onClose={() => {}} />);
    await screen.findAllByText("Dock · PPO");
    expect(screen.getByText("seed 42")).toBeInTheDocument();
    expect(screen.getByText("40 ep × 90d")).toBeInTheDocument();
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("shows the failure state when the export fetch rejects", async () => {
    mocks.getCompare.mockRejectedValue(new Error("offline"));
    render(<ComparisonDialog open onClose={() => {}} />);
    expect(
      await screen.findByText(/comparison export missing/),
    ).toBeInTheDocument();
  });

  it("fires onClose on Escape", async () => {
    const onClose = vi.fn();
    render(<ComparisonDialog open onClose={onClose} />);
    await screen.findByText("Policy Ladder");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(<ComparisonDialog open onClose={onClose} />);
    await screen.findByText("Policy Ladder");
    // the backdrop is the outermost fixed overlay
    fireEvent.click(screen.getByText("Policy Ladder").closest(".fixed")!);
    expect(onClose).toHaveBeenCalled();
  });
});
