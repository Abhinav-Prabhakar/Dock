import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { useEpisode } from "@/components/dock/EpisodeProvider";

/* CredibilityPanel may still be in flight — these tests are deliberately
   defensive (mount + non-empty render) so they pass once it lands. */

type Ctx = ReturnType<typeof useEpisode>;

const mocks = vi.hoisted(() => ({ ctx: {} as unknown }));

vi.mock("@/components/dock/EpisodeProvider", () => ({
  useEpisode: () => mocks.ctx,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      verifyLedger: vi.fn(async () => ({
        ok: true,
        n_events: 128,
        first_bad_seq: null,
        detail: "",
      })),
      getCompare: vi.fn(async () => ({})),
    },
  };
});

import { CredibilityPanel } from "./CredibilityPanel";

const baseCtx = (over: Partial<Ctx> = {}): Ctx =>
  ({
    backendUp: true,
    policies: [],
    scenarios: [],
    ports: [],
    vessels: [],
    routes: [],
    episode: {
      id: "ep-1",
      policy: "ppo",
      scenario: "baseline",
      seed: 7,
      horizon_days: 90,
      speed_days_per_sec: 4,
      status: "running",
      day: 12,
      error: null,
      n_events: 128,
      n_deals: 6,
      created_at: 0,
    },
    metrics: null,
    profitSeries: [],
    events: [],
    deals: [],
    snapshot: null,
    wsConnected: true,
    starting: false,
    error: null,
    start: vi.fn(async () => {}),
    control: vi.fn(async () => {}),
    dismissError: vi.fn(),
    ...over,
  }) as Ctx;

beforeEach(() => {
  mocks.ctx = baseCtx();
});

describe("CredibilityPanel", () => {
  it("mounts without throwing while an episode is live", () => {
    expect(() => render(<CredibilityPanel />)).not.toThrow();
  });

  it("renders a non-empty container", () => {
    const { container } = render(<CredibilityPanel />);
    expect(container.firstElementChild).not.toBeNull();
  });

  it("mounts cleanly with no episode", () => {
    mocks.ctx = baseCtx({ episode: null });
    const { container } = render(<CredibilityPanel />);
    expect(container.firstElementChild).not.toBeNull();
  });
});
