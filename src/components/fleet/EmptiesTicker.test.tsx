import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { useEpisode } from "@/components/dock/EpisodeProvider";
import type { EpisodeSnapshot } from "@/lib/api";

type Ctx = ReturnType<typeof useEpisode>;

const mocks = vi.hoisted(() => ({ ctx: {} as unknown }));

vi.mock("@/components/dock/EpisodeProvider", () => ({
  useEpisode: () => mocks.ctx,
}));

import { EmptiesTicker } from "./EmptiesTicker";

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

const snapshot = (empties: Record<string, number>): EpisodeSnapshot => ({
  id: "ep-1",
  policy: "ppo",
  scenario: "baseline",
  status: "running",
  day: 12,
  metrics: {} as EpisodeSnapshot["metrics"],
  vessels: [],
  empties,
});

beforeEach(() => {
  mocks.ctx = baseCtx();
});

describe("EmptiesTicker", () => {
  it("shows the 'no live data' pill without a snapshot", () => {
    render(<EmptiesTicker />);
    expect(screen.getByText("empties")).toBeInTheDocument();
    expect(screen.getByText("no live data")).toBeInTheDocument();
  });

  it("renders one chip per port, sorted by TEU descending", () => {
    mocks.ctx = baseCtx({
      snapshot: snapshot({ SGSIN: 87, CNSHA: 1234, NLRTM: 560 }),
    });
    const { container } = render(<EmptiesTicker />);
    expect(screen.getByText("CNSHA")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("SGSIN")).toBeInTheDocument();

    // DOM order is desc by teu: CNSHA(1234) → NLRTM(560) → SGSIN(87)
    const chips = Array.from(container.querySelectorAll("span.chip"));
    const ids = chips.map((c) => c.children[1]?.textContent);
    expect(ids).toEqual(["CNSHA", "NLRTM", "SGSIN"]);
  });

  it("rounds fractional TEU counts", () => {
    mocks.ctx = baseCtx({ snapshot: snapshot({ CNSHA: 99.6 }) });
    render(<EmptiesTicker />);
    expect(screen.getByText("100")).toBeInTheDocument();
  });
});
