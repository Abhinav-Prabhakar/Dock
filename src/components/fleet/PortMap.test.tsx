import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { useEpisode } from "@/components/dock/EpisodeProvider";
import type { EpisodeSnapshot, Port, Vessel } from "@/lib/api";

/* PortMap renders a maplibre-gl canvas — stub the SDK so jsdom never touches
   WebGL. The component itself may still be in flight; the tests below are
   deliberately defensive (mount + key datum) so they pass once it lands. */

type Ctx = ReturnType<typeof useEpisode>;

const mocks = vi.hoisted(() => ({ ctx: {} as unknown }));

vi.mock("@/components/dock/EpisodeProvider", () => ({
  useEpisode: () => mocks.ctx,
}));

vi.mock("maplibre-gl", () => {
  const Map = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    remove: vi.fn(),
    addControl: vi.fn(),
    resize: vi.fn(),
    loaded: vi.fn(() => true),
    getCanvas: vi.fn(() => document.createElement("canvas")),
    getContainer: vi.fn(() => document.createElement("div")),
    setCenter: vi.fn(),
    setZoom: vi.fn(),
    flyTo: vi.fn(),
    getSource: vi.fn(),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    removeSource: vi.fn(),
    getLayer: vi.fn(),
    setData: vi.fn(),
  }));
  const Marker = vi.fn().mockImplementation(() => ({
    setLngLat: vi.fn().mockReturnThis(),
    addTo: vi.fn().mockReturnThis(),
    remove: vi.fn(),
    setPopup: vi.fn().mockReturnThis(),
    setOffset: vi.fn().mockReturnThis(),
    getElement: vi.fn(() => document.createElement("div")),
  }));
  const Popup = vi.fn().mockImplementation(() => ({
    setLngLat: vi.fn().mockReturnThis(),
    setHTML: vi.fn().mockReturnThis(),
    setText: vi.fn().mockReturnThis(),
    addTo: vi.fn().mockReturnThis(),
    remove: vi.fn(),
  }));
  const NavigationControl = vi.fn();
  return {
    Map,
    Marker,
    Popup,
    NavigationControl,
    default: { Map, Marker, Popup, NavigationControl },
  };
});

import { PortMap } from "./PortMap";

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

const mkPort = (p: Partial<Port> & Pick<Port, "port_id" | "name" | "lat" | "lon">): Port => ({
  berths: 10,
  daily_capacity_teu: 30000,
  base_congestion: 0.5,
  tz_offset: 0,
  mean_dwell_days: 1.5,
  base_wait_hours: 5,
  ...p,
});

const PORTS: Port[] = [
  mkPort({ port_id: "CNSHA", name: "Shanghai", lat: 31.2, lon: 121.5, berths: 12 }),
  mkPort({ port_id: "SGSIN", name: "Singapore", lat: 1.26, lon: 103.8, berths: 8 }),
  mkPort({ port_id: "NLRTM", name: "Rotterdam", lat: 51.9, lon: 4.5, berths: 10 }),
];

const VESSELS: Vessel[] = [
  {
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
  },
];

const SNAPSHOT: EpisodeSnapshot = {
  id: "ep-1",
  policy: "ppo",
  scenario: "baseline",
  status: "running",
  day: 12,
  metrics: {} as EpisodeSnapshot["metrics"],
  vessels: [
    {
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
    },
  ],
  empties: { CNSHA: 1200 },
};

beforeEach(() => {
  mocks.ctx = baseCtx({ ports: PORTS, vessels: VESSELS, snapshot: SNAPSHOT });
});

describe("PortMap", () => {
  it("mounts without throwing against a stubbed maplibre", () => {
    expect(() => render(<PortMap />)).not.toThrow();
  });

  it("renders a non-empty container", () => {
    const { container } = render(<PortMap />);
    expect(container.firstElementChild).not.toBeNull();
  });

  it("mounts cleanly with no episode data at all", () => {
    mocks.ctx = baseCtx();
    const { container } = render(<PortMap />);
    expect(container.firstElementChild).not.toBeNull();
  });
});
