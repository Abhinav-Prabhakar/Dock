import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Anchor, Ship } from "lucide-react";
import { Empty, HashChip, MeterBar, Pill, StatusDot } from "./ui";

describe("Pill", () => {
  it("renders children for every tone", () => {
    const tones = ["ok", "warn", "bad", "accent", "neutral"] as const;
    for (const tone of tones) {
      const { unmount } = render(<Pill tone={tone}>label-{tone}</Pill>);
      expect(screen.getByText(`label-${tone}`)).toBeInTheDocument();
      unmount();
    }
  });

  it("applies the tone colorway class", () => {
    const { container } = render(<Pill tone="bad">x</Pill>);
    expect(container.firstElementChild).toHaveClass("text-pending-soft");
  });

  it("renders an icon when provided", () => {
    const { container } = render(
      <Pill tone="accent" icon={Anchor}>
        anchored
      </Pill>,
    );
    expect(screen.getByText("anchored")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("MeterBar", () => {
  const inner = (c: HTMLElement) =>
    c.firstElementChild?.firstElementChild as HTMLElement;

  it("clamps pct below 0 to 0%", () => {
    const { container } = render(<MeterBar pct={-0.4} />);
    expect(inner(container)).toHaveStyle({ width: "0%" });
  });

  it("clamps pct above 1 to 100%", () => {
    const { container } = render(<MeterBar pct={1.7} />);
    expect(inner(container)).toHaveStyle({ width: "100%" });
  });

  it("renders fractional pct as inline width", () => {
    const { container } = render(<MeterBar pct={0.42} tone="loaded" />);
    expect(inner(container)).toHaveStyle({ width: "42%" });
    expect(inner(container)).toHaveClass("to-loaded");
  });
});

describe("StatusDot", () => {
  it("uses the live pulse class", () => {
    const { container } = render(<StatusDot tone="live" />);
    expect(container.firstElementChild).toHaveClass("bg-loaded");
    expect(container.firstElementChild).toHaveClass("animate-pulse");
  });

  it("uses the idle class by default", () => {
    const { container } = render(<StatusDot />);
    expect(container.firstElementChild).toHaveClass("bg-faint");
  });
});

describe("Empty", () => {
  it("renders icon + children", () => {
    const { container } = render(<Empty icon={Ship}>nothing here yet</Empty>);
    expect(screen.getByText("nothing here yet")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("HashChip", () => {
  it("renders an em dash for a missing value", () => {
    render(<HashChip value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders the truncated hash", () => {
    render(<HashChip value="abcdef1234567890abcd" />);
    expect(screen.getByText("abcdef12…abcd")).toBeInTheDocument();
  });

  it("copies the full hash and shows the copied tick", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = render(<HashChip value="abcdef1234567890abcd" />);
    fireEvent.click(screen.getByRole("button"));
    expect(writeText).toHaveBeenCalledWith("abcdef1234567890abcd");
    // copied state swaps the Copy icon for a Check icon
    expect(container.querySelector("svg.text-loaded-soft")).not.toBeNull();
  });
});
