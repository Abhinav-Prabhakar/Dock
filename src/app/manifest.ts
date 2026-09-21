import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dock",
    short_name: "Dock",
    description:
      "Opportunity-cost pricing, negotiation and settlement for container shipping",
    start_url: "/",
    display: "standalone",
    background_color: "#060a20",
    theme_color: "#060a20",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
      {
        src: "/assets/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/assets/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
