import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { useEpisode } from "@/components/dock/EpisodeProvider";
import type { Deal, EpisodeDescriptor } from "@/lib/api";

type Ctx = ReturnType<typeof useEpisode>;

const mocks = vi.hoisted(() => ({
  ctx: {} as unknown,
  verifyLedger: vi.fn(),
}));

vi.mock("@/components/dock/EpisodeProvider", () => ({
  useEpisode: () => mocks.ctx,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, verifyLedger: mocks.verifyLedger },
  };
});

import { DealsRail } from "./DealsRail";

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

const EPISODE: EpisodeDescriptor = {
  id: "ep-1",
  policy: "ppo",
  scenario: "baseline",
  seed: 7,
  horizon_days: 90,
  speed_days_per_sec: 4,
  status: "running",
  day: 30,
  error: null,
  n_events: 128,
  n_deals: 1,
  created_at: 0,
};

const DEAL: Deal = {
  deal_id: "deal-1",
  request_id: 7,
  kind: "flex_window",
  origin: "CNSHA",
  dest: "NLRTM",
  teu: 40,
  price_usd: 1450,
  segment: "urgent",
  vessel_id: "v1",
  board_day: 20,
  discharge_eta: 38,
  terms: {
    window_lo: 18,
    window_hi: 22,
    delivery_deadline: 40,
    penalty_bps: 250,
  },
  status: "settled",
  register_day: 3,
  actual_departure: 20,
  actual_delivery: 38,
  settled_outcome: "settled_full",
  settled_amount_usd: 58000,
  contract: "0xabcdef1234567890",
  tx: {
    register: "0xreg1234567890abcd",
    departure: "",
    delivery: "",
    settle: "",
  },
};

beforeEach(() => {
  mocks.ctx = baseCtx({ episode: EPISODE, deals: [DEAL] });
  mocks.verifyLedger.mockReset();
  mocks.verifyLedger.mockResolvedValue({
    ok: true,
    n_events: 128,
    first_bad_seq: null,
    detail: "",
  });
});

/* ---------- tests ---------- */

describe("DealsRail", () => {
  it("renders the deal card: route, price, segment, terms, settled pill", () => {
    render(<DealsRail />);
    expect(screen.getByText("on-chain deals")).toBeInTheDocument();
    expect(screen.getByText("CNSHA → NLRTM")).toBeInTheDocument();
    expect(screen.getByText("$1,450")).toBeInTheDocument();
    expect(screen.getByText("urgent")).toBeInTheDocument();
    expect(screen.getByText("flex window")).toBeInTheDocument();
    // terms strip: window, deadline, penalty
    expect(screen.getByText("d18–d22")).toBeInTheDocument();
    expect(screen.getByText("d40")).toBeInTheDocument();
    expect(screen.getByText("2.5%")).toBeInTheDocument();
    // settled outcome pill
    expect(screen.getByText(/Settled Full · \$58,000/)).toBeInTheDocument();
  });

  it("renders truncated hash chips for the contract and tx hashes", () => {
    render(<DealsRail />);
    // contract "0xabcdef1234567890" → 0xabcdef…7890
    expect(screen.getByText("0xabcdef…7890")).toBeInTheDocument();
    // tx.register "0xreg1234567890abcd" → 0xreg123…abcd
    expect(screen.getByText("0xreg123…abcd")).toBeInTheDocument();
  });

  it("verify ledger calls the API and reports an intact chain", async () => {
    render(<DealsRail />);
    const buttons = screen.getAllByRole("button", { name: /verify ledger/ });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(mocks.verifyLedger).toHaveBeenCalledWith("ep-1");
    expect(
      await screen.findByText(/128 events · hash chain intact/),
    ).toBeInTheDocument();
  });

  it("reports a broken chain when verification fails", async () => {
    mocks.verifyLedger.mockResolvedValue({
      ok: false,
      n_events: 128,
      first_bad_seq: 42,
      detail: "chain break at seq 42",
    });
    render(<DealsRail />);
    fireEvent.click(screen.getAllByRole("button", { name: /verify ledger/ }).pop()!);
    expect(await screen.findByText(/chain break at seq 42/)).toBeInTheDocument();
  });

  it("empty states: no episode vs live episode with no deals", () => {
    mocks.ctx = baseCtx({ episode: null, deals: [] });
    const { unmount } = render(<DealsRail />);
    expect(
      screen.getByText(/start an episode — deals appear here/),
    ).toBeInTheDocument();
    unmount();

    mocks.ctx = baseCtx({ episode: EPISODE, deals: [] });
    render(<DealsRail />);
    expect(
      screen.getByText(/no conditional deals yet — this policy never counters/),
    ).toBeInTheDocument();
  });
});
