import { ImageResponse } from "next/og";

export const alt = "Dock — revenue management for container fleets";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const anchorMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12183c"/><stop offset="1" stop-color="#060a20"/></linearGradient><radialGradient id="bloom" cx="0.62" cy="0.3" r="0.75"><stop offset="0" stop-color="#4a58cd" stop-opacity="0.34"/><stop offset="0.62" stop-color="#4a58cd" stop-opacity="0"/></radialGradient><linearGradient id="mark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a93f5"/><stop offset="1" stop-color="#6a73ea"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#bg)"/><rect width="512" height="512" rx="112" fill="url(#bloom)"/><g fill="none" stroke="url(#mark)" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"><circle cx="256" cy="146" r="36"/><path d="M256 182v240"/><path d="M186 236h140"/><path d="M134 292c10 88 58 134 122 134s112-46 122-134"/><path d="M134 292l-18-38"/><path d="M378 292l18-38"/></g><rect x="144" y="454" width="224" height="7" rx="3.5" fill="#3fbdb0" fill-opacity="0.3"/><rect x="10" y="10" width="492" height="492" rx="103" fill="none" stroke="#949edc" stroke-opacity="0.25" stroke-width="2"/></svg>`;

const markSrc = `data:image/svg+xml;base64,${Buffer.from(anchorMark).toString("base64")}`;

const chips = ["RL policy", "hash-chained ledger", "live digital twin"];

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background:
            "linear-gradient(180deg, #0b1130 0%, #070b22 55%, #05081c 100%)",
          color: "#eef0ff",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            background:
              "radial-gradient(ellipse at 62% 32%, rgba(74, 88, 205, 0.34), rgba(74, 88, 205, 0) 62%)",
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "72px 84px",
            width: "100%",
            height: "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            <img src={markSrc} width={128} height={128} alt="" />
            <div
              style={{
                display: "flex",
                fontSize: 56,
                letterSpacing: "0.02em",
              }}
            >
              Dock
            </div>
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 56,
              fontSize: 68,
              lineHeight: 1.12,
              letterSpacing: "-0.02em",
              maxWidth: 960,
            }}
          >
            Revenue management for container fleets
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 30,
              color: "#9aa1c9",
            }}
          >
            bid pricing · counter-offers · on-chain settlement
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 56 }}>
            {chips.map((chip) => (
              <div
                key={chip}
                style={{
                  display: "flex",
                  alignItems: "center",
                  borderRadius: 999,
                  border: "1px solid rgba(106, 115, 234, 0.4)",
                  background: "rgba(106, 115, 234, 0.15)",
                  color: "#aab4ff",
                  fontSize: 22,
                  padding: "10px 24px",
                }}
              >
                {chip}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
