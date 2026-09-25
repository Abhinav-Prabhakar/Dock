import { describe, expect, it } from "vitest";
import type { EpisodeEvent } from "@/lib/api";
import {
  COUNTER_KIND_LABEL,
  fmtPct,
  fmtUsd,
  fmtUsdM,
  humanizeToken,
  outcomeTone,
  shortHash,
  stampFor,
} from "@/lib/offers";

/** Minimal EpisodeEvent shell — stampFor only reads outcome/kind. */
const ev = (over: Partial<EpisodeEvent>): EpisodeEvent =>
  ({
    seq: 1,
    day: 1,
    type: "booking.decision",
    prev_hash: "p",
    hash: "h",
    ...over,
  }) as EpisodeEvent;

describe("stampFor", () => {
  it("booked + accept → booked / BOOKED", () => {
    expect(stampFor(ev({ outcome: "booked", kind: "accept" }))).toEqual({
      cls: "booked",
      text: "BOOKED",
    });
  });

  it("booked + flex_window → counter / DEAL · FLEX WINDOW", () => {
    expect(stampFor(ev({ outcome: "booked", kind: "flex_window" }))).toEqual({
      cls: "counter",
      text: "DEAL · FLEX WINDOW",
    });
  });

  it("booked: prefixed outcome still counts as booked", () => {
    expect(stampFor(ev({ outcome: "booked:flex_window", kind: "flex_window" }))).toEqual({
      cls: "counter",
      text: "DEAL · FLEX WINDOW",
    });
  });

  it("booked + alt_hub / split use their counter labels", () => {
    expect(stampFor(ev({ outcome: "booked", kind: "alt_hub" })).text).toBe(
      "DEAL · ALT HUB",
    );
    expect(stampFor(ev({ outcome: "booked", kind: "split" })).text).toBe(
      "DEAL · SPLIT",
    );
  });

  it("counter_declined → passed / NO DEAL", () => {
    expect(stampFor(ev({ outcome: "counter_declined", kind: "flex_window" }))).toEqual({
      cls: "passed",
      text: "NO DEAL",
    });
    expect(
      stampFor(ev({ outcome: "counter_declined:flex_window", kind: "flex_window" })),
    ).toEqual({ cls: "passed", text: "NO DEAL" });
  });

  it("declined and price_reject → passed / PASSED", () => {
    expect(stampFor(ev({ outcome: "declined", kind: "reject" }))).toEqual({
      cls: "passed",
      text: "PASSED",
    });
    expect(stampFor(ev({ outcome: "price_reject", kind: "reject" }))).toEqual({
      cls: "passed",
      text: "PASSED",
    });
  });

  it("rejected:* and unknown outcomes → rejected / REJECTED", () => {
    for (const outcome of ["rejected", "rejected:no_capacity", "rejected:late", "bogus"]) {
      expect(stampFor(ev({ outcome }))).toEqual({
        cls: "rejected",
        text: "REJECTED",
      });
    }
  });

  it("covers every declared counter kind label", () => {
    for (const kind of Object.keys(COUNTER_KIND_LABEL)) {
      const stamp = stampFor(ev({ outcome: "booked", kind }));
      expect(stamp.cls).toBe("counter");
      expect(stamp.text).toBe(`DEAL · ${COUNTER_KIND_LABEL[kind].toUpperCase()}`);
    }
  });
});

describe("outcomeTone", () => {
  it("booked* → won", () => {
    expect(outcomeTone("booked")).toBe("won");
    expect(outcomeTone("booked:flex_window")).toBe("won");
  });

  it("counter_declined* / declined / price_reject → passed", () => {
    expect(outcomeTone("counter_declined")).toBe("passed");
    expect(outcomeTone("counter_declined:alt_hub")).toBe("passed");
    expect(outcomeTone("declined")).toBe("passed");
    expect(outcomeTone("price_reject")).toBe("passed");
  });

  it("everything else → rejected", () => {
    expect(outcomeTone("rejected")).toBe("rejected");
    expect(outcomeTone("rejected:no_capacity")).toBe("rejected");
    expect(outcomeTone("")).toBe("rejected");
  });
});

describe("humanizeToken", () => {
  it("title-cases snake_case tokens", () => {
    expect(humanizeToken("flex_window")).toBe("Flex Window");
    expect(humanizeToken("alt_hub")).toBe("Alt Hub");
  });

  it("handles kebab-case too", () => {
    expect(humanizeToken("flex-window")).toBe("Flex Window");
  });

  it("drops colon suffixes (booked:flex_window → Booked)", () => {
    expect(humanizeToken("booked:flex_window")).toBe("Booked");
  });
});

describe("shortHash", () => {
  it("truncates long hashes", () => {
    expect(shortHash("abcdef1234567890abcd")).toBe("abcdef12…abcd");
  });

  it("null / undefined / empty → em dash", () => {
    expect(shortHash(null)).toBe("—");
    expect(shortHash(undefined)).toBe("—");
    expect(shortHash("")).toBe("—");
  });
});

describe("number formatting", () => {
  it("fmtUsd rounds and groups", () => {
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(1234.5)).toBe("$1,235");
    expect(fmtUsd(1234567)).toBe("$1,234,567");
  });

  it("fmtUsdM scales to millions and signs negatives with −", () => {
    expect(fmtUsdM(2_500_000)).toBe("$2.5M");
    expect(fmtUsdM(-1_200_000)).toBe("−$1.2M");
    expect(fmtUsdM(0)).toBe("$0.0M");
  });

  it("fmtPct renders one-decimal percents incl. negatives", () => {
    expect(fmtPct(0.123)).toBe("12.3%");
    expect(fmtPct(1)).toBe("100.0%");
    expect(fmtPct(-0.05)).toBe("-5.0%");
  });
});
