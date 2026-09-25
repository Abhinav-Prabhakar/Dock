import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EpisodeEvent, OfferData } from "@/lib/api";

/* WhyDrawer pulls the offers compare export through api.getCompare — stub it.
   NOTE: the component caches the export promise module-wide, so the first
   successful fetch is shared by every later open in this file. */

const mocks = vi.hoisted(() => ({ getCompare: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, getCompare: mocks.getCompare },
  };
});

import { WhyDrawer } from "./WhyDrawer";

/* ---------- fixtures ---------- */

const OFFER: EpisodeEvent = {
  seq: 12,
  day: 5,
  type: "booking.decision",
  prev_hash: "prev",
  hash: "abcdef1234567890ffff",
  request_id: 42,
  origin: "CNSHA",
  dest: "NLRTM",
  teu: 40,
  weight_t: 560,
  segment: "urgent",
  cargo_type: "reefer",
  req_dep_day: 20,
  flex_days: 3,
  n_options: 2,
  vessel_id: "v1",
  price: 1500,
  market_rate: 1400,
  outcome: "booked",
  kind: "flex_window",
  reason: "bid_pressure",
} as EpisodeEvent;

const EXPORT_OFFERS: OfferData[] = [
  {
    request_id: 42,
    day: 5,
    origin: "CNSHA",
    dest: "NLRTM",
    teu: 40,
    segment: "urgent",
    cargo_type: "reefer",
    req_dep_day: 20,
    flex_days: 3,
    decision_kind: "accept",
    option_idx: 0,
    discount_pct: 0,
    outcome: "booked",
    price: 1500,
    explain: {
      engine: "heuristic_bid",
      quote_per_teu: 1500,
      bid_price_per_teu: 1450,
      market_rate_per_teu: 1400,
      reason: "bid_pressure",
      legs: [
        {
          leg_idx: 0,
          dep_day: 20,
          remaining_teu: 300,
          expected_teu: 500,
          pressure: 0.6,
          market_rate: 1400,
          bid_price: 1450,
        },
      ],
      text: "Priced just under quote because leg pressure is moderate.",
    },
  },
];

beforeEach(() => {
  mocks.getCompare.mockReset();
  mocks.getCompare.mockResolvedValue(EXPORT_OFFERS);
});

/* ---------- tests ---------- */

describe("WhyDrawer", () => {
  it("renders nothing when offer is null", () => {
    const { container } = render(<WhyDrawer offer={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the header lane chip, stamp and hero price", async () => {
    render(<WhyDrawer offer={OFFER} onClose={() => {}} />);
    await screen.findByText(/explain sample — holdout export/); // flush fetch
    // lane chip renders "CNSHA → NLRTM" as sibling text nodes in one span
    expect(screen.getByText(/CNSHA/)).toBeInTheDocument();
    expect(screen.getByText(/NLRTM/)).toBeInTheDocument();
    // booked + flex_window → negotiated stamp
    expect(screen.getByText("DEAL · FLEX WINDOW")).toBeInTheDocument();
    // $1,500 appears as hero price and as the explain "quote" bar value
    expect(screen.getAllByText("$1,500").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/vs mkt/)).toBeInTheDocument();
    // field grid
    expect(screen.getByText("urgent")).toBeInTheDocument();
    expect(screen.getByText(/reefer/)).toBeInTheDocument();
    expect(screen.getByText(/±3d/)).toBeInTheDocument(); // flex window on dep day
    expect(screen.getByText("v1")).toBeInTheDocument();
    // footer: ledger seq + truncated hash
    expect(screen.getByText(/seq 12 · d5/)).toBeInTheDocument();
    expect(screen.getByText("abcdef12…ffff")).toBeInTheDocument();
  });

  it("loads the explain export and renders quote/bid/market bars", async () => {
    render(<WhyDrawer offer={OFFER} onClose={() => {}} />);
    expect(await screen.findByText("why this price")).toBeInTheDocument();
    // matched explain block — "Bid Pressure" appears both as the offer reason
    // chip and inside the explain view once the export resolves
    await screen.findByText(/explain sample — holdout export/);
    expect(screen.getAllByText("Bid Pressure").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("$1,450")).toBeInTheDocument(); // bid bar value
    expect(screen.getByText(/leg 0 · d20/)).toBeInTheDocument();
  });

  it("fetches the offers compare export on open", async () => {
    // fresh module instance → fresh offersPromise cache → observable fetch
    vi.resetModules();
    const { WhyDrawer: FreshWhyDrawer } = await import("./WhyDrawer");
    render(<FreshWhyDrawer offer={OFFER} onClose={() => {}} />);
    // the explain block only appears once the export promise resolves —
    // awaiting it both flushes the state update and proves the fetch ran
    await screen.findByText(/explain sample — holdout export/);
    expect(mocks.getCompare).toHaveBeenCalledWith("offers");
  });

  it("shows the unavailable state when the export fetch rejects", async () => {
    mocks.getCompare.mockRejectedValue(new Error("offline"));
    // bypass the module-level offersPromise cache with a fresh module instance
    vi.resetModules();
    const { WhyDrawer: FreshWhyDrawer } = await import("./WhyDrawer");
    render(<FreshWhyDrawer offer={OFFER} onClose={() => {}} />);
    expect(
      await screen.findByText(/explain export unavailable/),
    ).toBeInTheDocument();
  });

  it("fires onClose on Escape and on backdrop click", async () => {
    const onClose = vi.fn();
    render(<WhyDrawer offer={OFFER} onClose={onClose} />);
    await screen.findByText(/explain sample — holdout export/); // flush async
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose when the dim backdrop is clicked", async () => {
    const onClose = vi.fn();
    const { container } = render(<WhyDrawer offer={OFFER} onClose={onClose} />);
    await screen.findByText(/explain sample — holdout export/); // flush async
    fireEvent.click(container.querySelector(".why-back")!);
    expect(onClose).toHaveBeenCalled();
  });
});
