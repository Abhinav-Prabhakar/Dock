import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { useEpisode } from "@/components/dock/EpisodeProvider";
import type { EpisodeEvent } from "@/lib/api";

type Ctx = ReturnType<typeof useEpisode>;

const mocks = vi.hoisted(() => ({ ctx: {} as unknown }));

vi.mock("@/components/dock/EpisodeProvider", () => ({
  useEpisode: () => mocks.ctx,
}));

import { DecisionLogRail } from "./DecisionLogRail";

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

const ev = (over: Partial<EpisodeEvent>): EpisodeEvent =>
  ({
    seq: 1,
    day: 3,
    type: "booking.decision",
    prev_hash: "p",
    hash: "h",
    ...over,
  }) as EpisodeEvent;

const EVENTS: EpisodeEvent[] = [
  ev({
    seq: 1,
    type: "booking.decision",
    origin: "CNSHA",
    dest: "NLRTM",
    outcome: "booked",
    kind: "accept",
  }),
  ev({
    seq: 2,
    type: "booking.decision",
    origin: "SGSIN",
    dest: "USNYC",
    outcome: "rejected:no_capacity",
    kind: "reject",
  }),
  ev({
    seq: 3,
    day: 12,
    type: "settlement.settled",
    deal_id: "abcdef1234567890",
    outcome: "settled_full",
    amount_usd: 42000,
  }),
];

beforeEach(() => {
  mocks.ctx = baseCtx({ events: EVENTS });
});

describe("DecisionLogRail", () => {
  it("shows the empty state when there are no events", () => {
    mocks.ctx = baseCtx({ events: [] });
    render(<DecisionLogRail />);
    expect(
      screen.getByText(/no decisions yet — start an episode/),
    ).toBeInTheDocument();
  });

  it("renders newest-first rows with day, route text and outcome stamp", () => {
    render(<DecisionLogRail />);
    expect(screen.getByText("decision log")).toBeInTheDocument();
    expect(screen.getByText("CNSHA→NLRTM")).toBeInTheDocument();
    expect(screen.getByText("BOOKED")).toBeInTheDocument();
    expect(screen.getByText("SGSIN→USNYC")).toBeInTheDocument();
    expect(screen.getByText("REJECTED")).toBeInTheDocument();
    // settlement row anchors on the short deal id
    expect(screen.getByText("abcdef12…7890")).toBeInTheDocument();
  });

  it("counts events in the filter chips", () => {
    render(<DecisionLogRail />);
    const bookingsChip = screen.getByRole("button", { name: /bookings/ });
    expect(bookingsChip.textContent).toContain("2");
    const chainChip = screen.getByRole("button", { name: /chain/ });
    expect(chainChip.textContent).toContain("1");
  });

  it("filters rows when a chip is clicked", () => {
    render(<DecisionLogRail />);
    fireEvent.click(screen.getByRole("button", { name: /bookings/ }));
    expect(screen.getByText("CNSHA→NLRTM")).toBeInTheDocument();
    // settlement row is filtered out
    expect(screen.queryByText("abcdef12…7890")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /chain/ }));
    expect(screen.queryByText("CNSHA→NLRTM")).not.toBeInTheDocument();
    expect(screen.getByText("abcdef12…7890")).toBeInTheDocument();
    // settled pill renders the humanized outcome
    expect(screen.getByText("full")).toBeInTheDocument();
  });
});
