import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { useEpisode } from "@/components/dock/EpisodeProvider";
import type { EpisodeSnapshot, EpisodeVessel, Vessel } from "@/lib/api";

/* ---------- mocked episode context ---------- */

type Ctx = ReturnType<typeof useEpisode>;

const mocks = vi.hoisted(() => ({ ctx: {} as unknown }));

vi.mock("@/components/dock/EpisodeProvider", () => ({
  useEpisode: () => mocks.ctx,
}));

import { VesselCards } from "./VesselCards";

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

const VESSEL: Vessel = {
  vessel_id: "v1",
  name: "Pacific Aurora",
  capacity_teu: 18000,
  reefer_plugs: 1200,
  min_speed_kt: 12,
  service_speed_kt: 18,
  max_speed_kt: 22,
  fuel_a_tpd: 80,
  fuel_b_tpd: 0.001,
  age_years: 4,
  draft_m: 15.5,
  loop: "CNSHA>SGSIN>NLRTM>USNYC>CNSHA",
};

const LIVE_SEA: EpisodeVessel = {
  vessel_id: "v1",
  name: "Pacific Aurora",
  mode: "SEA",
  port: null,
  from_port: "CNSHA",
  to_port: "SGSIN",
  leg_start_day: 10,
  leg_end_day: 22,
  progress: 0.5,
  onboard_teu: 4200,
  speed_kt: 19.4,
};

const snapshot = (vessels: EpisodeVessel[]): EpisodeSnapshot => ({
  id: "ep-1",
  policy: "ppo",
  scenario: "baseline",
  status: "running",
  day: 16,
  metrics: {} as EpisodeSnapshot["metrics"],
  vessels,
  empties: {},
});

beforeEach(() => {
  mocks.ctx = baseCtx({ vessels: [VESSEL] });
});

/* ---------- tests ---------- */

describe("VesselCards", () => {
  it("renders an empty state when the fleet spec sheet is missing", () => {
    mocks.ctx = baseCtx({ vessels: [] });
    render(<VesselCards />);
    expect(screen.getByText(/fleet specs unavailable/)).toBeInTheDocument();
  });

  it("renders one card per vessel with name, id and spec cells", () => {
    render(<VesselCards />);
    expect(screen.getByText("Pacific Aurora")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("18,000")).toBeInTheDocument(); // capacity
    // loop mini-map renders every stop
    expect(screen.getAllByText("CNSHA").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("NLRTM")).toBeInTheDocument();
  });

  it("shows the idle pill and dashes when no episode is live", () => {
    render(<VesselCards />);
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("shows live sea state: speed, onboard load, route leg", () => {
    mocks.ctx = baseCtx({
      vessels: [VESSEL],
      snapshot: snapshot([LIVE_SEA]),
    });
    render(<VesselCards />);
    expect(screen.getByText("sea")).toBeInTheDocument();
    expect(screen.getByText("4,200")).toBeInTheDocument(); // onboard teu
    expect(screen.getByText(/19\.4/)).toBeInTheDocument(); // speed_kt
    // SGSIN appears in both the loop chain and the live route leg
    expect(screen.getAllByText("SGSIN").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("50%")).toBeInTheDocument(); // leg progress
  });

  it("shows berthed state when the vessel is in port", () => {
    const inPort: EpisodeVessel = {
      ...LIVE_SEA,
      mode: "PORT",
      port: "NLRTM",
      speed_kt: 0,
    };
    mocks.ctx = baseCtx({
      vessels: [VESSEL],
      snapshot: snapshot([inPort]),
    });
    render(<VesselCards />);
    expect(screen.getByText("port")).toBeInTheDocument();
    expect(screen.getByText("berthed")).toBeInTheDocument();
    // current port is highlighted in the loop chain
    expect(screen.getAllByText("NLRTM").length).toBeGreaterThanOrEqual(1);
  });
});
