"use client";

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Anchor } from "lucide-react";
import type { EpisodeVessel, Port, Vessel } from "@/lib/api";
import { useEpisode } from "@/components/dock/EpisodeProvider";

/* Live fleet map — a fully local dark vector basemap (public/map/**, no API
   keys) with port dots, dashed accent service loops and ship glyphs that
   interpolate along legs as the episode snapshot polls in (~1s).
   The map instance is created exactly once; all data arrives through
   GeoJSON setData + Marker.setLngLat so we never re-create the map. */

type LngLat = [number, number];

const ACCENT = "#7c87f2";
const LOOPS_SOURCE = "dock-loops";
const LOOPS_LAYER = "dock-loops-line";

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** Split one leg at the antimeridian so Pacific crossings draw short way. */
function splitLeg(a: LngLat, b: LngLat): LngLat[][] {
  const d = b[0] - a[0];
  if (Math.abs(d) <= 180) return [[a, b]];
  const bLon = d > 0 ? b[0] - 360 : b[0] + 360;
  const edge = d > 0 ? -180 : 180;
  const t = (edge - a[0]) / (bLon - a[0]);
  const lat = a[1] + t * (b[1] - a[1]);
  return d > 0
    ? [
        [a, [-180, lat]],
        [[180, lat], b],
      ]
    : [
        [a, [180, lat]],
        [[-180, lat], b],
      ];
}

/** One MultiLineString feature per distinct service loop. */
function loopFeatures(
  vessels: Vessel[],
  portById: Map<string, Port>,
): GeoJSON.Feature[] {
  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const v of vessels) {
    const ids = (v.loop ?? "")
      .split(">")
      .map((s) => s.trim())
      .filter(Boolean);
    const key = ids.join(">");
    if (ids.length < 2 || seen.has(key)) continue;
    seen.add(key);
    const pts: LngLat[] = ids
      .map((id) => portById.get(id))
      .filter((p): p is Port => !!p)
      .map((p) => [p.lon, p.lat]);
    if (pts.length < 2) continue;
    pts.push(pts[0]); // loops are circular — close the ring
    const lines: LngLat[][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      lines.push(...splitLeg(pts[i], pts[i + 1]));
    }
    features.push({
      type: "Feature",
      properties: { vessel: v.vessel_id },
      geometry: { type: "MultiLineString", coordinates: lines },
    });
  }
  return features;
}

/** Interpolated position along a leg, taking the short way round the globe. */
function lerpSea(from: LngLat, to: LngLat, t: number): LngLat {
  let d = to[0] - from[0];
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  let lon = from[0] + d * t;
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  return [lon, from[1] + (to[1] - from[1]) * t];
}

/** Compass bearing (deg, 0 = north) for rotating the ship glyph. */
function bearingDeg(from: LngLat, to: LngLat): number {
  let dLon = to[0] - from[0];
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  const la1 = (from[1] * Math.PI) / 180;
  const la2 = (to[1] * Math.PI) / 180;
  const lam = (dLon * Math.PI) / 180;
  const y = Math.sin(lam) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lam);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function vesselLngLat(
  v: EpisodeVessel,
  portById: Map<string, Port>,
): LngLat | null {
  if (v.mode === "PORT") {
    const p = portById.get(v.port ?? v.to_port);
    return p ? [p.lon, p.lat] : null;
  }
  const from = portById.get(v.from_port);
  const to = portById.get(v.to_port);
  if (!from || !to) return null;
  return lerpSea([from.lon, from.lat], [to.lon, to.lat], v.progress);
}

function fmtInt(n: number) {
  return Math.round(n).toLocaleString("en-US");
}

const ROW = "flex items-center justify-between gap-4 text-[10px]";
const KEY = "uppercase tracking-[0.14em] text-faint";

function portPopupHtml(p: Port, empties?: number): string {
  const cong =
    p.base_congestion != null ? `${Math.round(p.base_congestion * 100)}%` : "—";
  const cap =
    p.daily_capacity_teu != null ? `${fmtInt(p.daily_capacity_teu)} teu` : "—";
  const emp = empties != null ? fmtInt(empties) : null;
  return `
    <div class="min-w-[168px]">
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-[11px] font-semibold text-hi">${p.name}</span>
        <span class="text-[9px] font-medium uppercase tracking-[0.14em] text-accent">${p.port_id}</span>
      </div>
      <div class="mt-2 flex flex-col gap-1 border-t border-edge pt-2">
        <div class="${ROW}"><span class="${KEY}">berths</span><span class="font-mono text-mid">${p.berths}</span></div>
        <div class="${ROW}"><span class="${KEY}">capacity</span><span class="font-mono text-mid">${cap}/day</span></div>
        <div class="${ROW}"><span class="${KEY}">congestion</span><span class="font-mono text-mid">${cong}</span></div>
        ${
          emp != null
            ? `<div class="${ROW}"><span class="${KEY}">empties</span><span class="font-mono text-loaded-soft">${emp}</span></div>`
            : ""
        }
      </div>
    </div>`;
}

function vesselPopupHtml(v: EpisodeVessel): string {
  const mode = v.mode === "SEA" ? "at sea" : "in port";
  return `
    <div class="min-w-[160px]">
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-[11px] font-semibold text-hi">${v.name}</span>
        <span class="text-[9px] font-medium uppercase tracking-[0.14em] ${v.mode === "SEA" ? "text-accent" : "text-loaded-soft"}">${mode}</span>
      </div>
      <div class="mt-2 flex flex-col gap-1 border-t border-edge pt-2">
        ${
          v.mode === "SEA"
            ? `<div class="${ROW}"><span class="${KEY}">leg</span><span class="font-mono text-mid">${v.from_port} → ${v.to_port}</span></div>
               <div class="${ROW}"><span class="${KEY}">progress</span><span class="font-mono text-mid">${Math.round(v.progress * 100)}%</span></div>`
            : `<div class="${ROW}"><span class="${KEY}">port</span><span class="font-mono text-mid">${v.port ?? v.to_port}</span></div>`
        }
        <div class="${ROW}"><span class="${KEY}">speed</span><span class="font-mono text-mid">${v.speed_kt.toFixed(1)} kn</span></div>
        <div class="${ROW}"><span class="${KEY}">onboard</span><span class="font-mono text-mid">${fmtInt(v.onboard_teu)} teu</span></div>
      </div>
    </div>`;
}

function buildPortEl(p: Port): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "flex cursor-pointer items-center gap-1.5";
  el.innerHTML = `
    <span class="block h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_7px_rgba(124,135,242,0.9)] ring-[3px] ring-accent/20"></span>
    <span class="rounded bg-ink/85 px-1 py-px text-[9px] font-medium uppercase tracking-[0.14em] text-low backdrop-blur-[2px]">${p.port_id}</span>`;
  return el;
}

function buildVesselEl(): { root: HTMLDivElement; svg: SVGSVGElement | null } {
  const el = document.createElement("div");
  el.className = "cursor-pointer";
  el.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18" style="display:block;filter:drop-shadow(0 0 4px rgba(124,135,242,0.75));transition:transform 0.6s linear">
      <path d="M9 1.8 L12.6 7.2 L12.6 13.4 Q12.6 15.3 10.9 15.3 L7.1 15.3 Q5.4 15.3 5.4 13.4 L5.4 7.2 Z"
            fill="${ACCENT}" stroke="#a9b1ff" stroke-width="0.6" stroke-linejoin="round"/>
      <rect x="7.7" y="8.4" width="2.6" height="4.4" rx="0.5" fill="#04060e" opacity="0.55"/>
    </svg>`;
  return { root: el, svg: el.querySelector("svg") };
}

export function PortMap() {
  const { ports, vessels, snapshot, episode } = useEpisode();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const portMarkersRef = useRef<maplibregl.Marker[]>([]);
  const vesselMarkersRef = useRef<
    Map<string, { marker: maplibregl.Marker; svg: SVGSVGElement | null }>
  >(new Map());
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const snapshotRef = useRef(snapshot);
  const portByIdRef = useRef<Map<string, Port>>(new Map());
  const reducedMotionRef = useRef(false);
  const [ready, setReady] = useState(false);

  const portById = useMemo(() => {
    const m = new Map<string, Port>();
    for (const p of ports) m.set(p.port_id, p);
    return m;
  }, [ports]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    portByIdRef.current = portById;
  }, [portById]);

  /* Create the map once — the guard absorbs React strict-mode remounts. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    reducedMotionRef.current =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const vesselMarkers = vesselMarkersRef.current;
    const map = new maplibregl.Map({
      container,
      style: "/map/style.json",
      center: [30, 28],
      zoom: 1.7,
      minZoom: 1.2,
      maxZoom: 7,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource(LOOPS_SOURCE, { type: "geojson", data: EMPTY_FC });
      const firstSymbol = map
        .getStyle()
        .layers?.find((l) => l.type === "symbol")?.id;
      map.addLayer(
        {
          id: LOOPS_LAYER,
          type: "line",
          source: LOOPS_SOURCE,
          paint: {
            "line-color": ACCENT,
            "line-opacity": 0.35,
            "line-width": 1.5,
            "line-dasharray": [2, 1.8],
          },
        },
        firstSymbol,
      );
      setReady(true);
    });

    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      portMarkersRef.current = [];
      vesselMarkers.clear();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  /* Port markers + popups — rebuilt only when the port list changes. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    for (const m of portMarkersRef.current) m.remove();
    portMarkersRef.current = [];

    for (const p of ports) {
      const el = buildPortEl(p);
      const marker = new maplibregl.Marker({
        element: el,
        anchor: "left",
        offset: [-4, 0],
      })
        .setLngLat([p.lon, p.lat])
        .addTo(map);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        popupRef.current?.remove();
        const empties = snapshotRef.current?.empties?.[p.port_id];
        popupRef.current = new maplibregl.Popup({
          className: "dock-popup",
          closeButton: false,
          closeOnClick: true,
          maxWidth: "260px",
          offset: 14,
        })
          .setLngLat([p.lon, p.lat])
          .setHTML(portPopupHtml(p, empties))
          .addTo(map);
        if (!reducedMotionRef.current) {
          map.easeTo({ center: [p.lon, p.lat], duration: 550 });
        }
      });
      portMarkersRef.current.push(marker);
    }
  }, [ready, ports]);

  /* Service loops — one GeoJSON source, setData on change, never re-created. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource(LOOPS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: loopFeatures(vessels, portById),
    });
  }, [ready, vessels, portById]);

  /* Vessel ship markers — created lazily, moved via setLngLat per snapshot. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const live = snapshot?.vessels ?? [];
    const seen = new Set<string>();

    for (const v of live) {
      const pos = vesselLngLat(v, portById);
      if (!pos) continue;
      seen.add(v.vessel_id);

      let rec = vesselMarkersRef.current.get(v.vessel_id);
      if (!rec) {
        const { root, svg } = buildVesselEl();
        const marker = new maplibregl.Marker({ element: root })
          .setLngLat(pos)
          .addTo(map);
        rec = { marker, svg };
        vesselMarkersRef.current.set(v.vessel_id, rec);
        root.addEventListener("click", (e) => {
          e.stopPropagation();
          const latest = snapshotRef.current?.vessels.find(
            (x) => x.vessel_id === v.vessel_id,
          );
          if (!latest) return;
          popupRef.current?.remove();
          popupRef.current = new maplibregl.Popup({
            className: "dock-popup",
            closeButton: false,
            closeOnClick: true,
            maxWidth: "260px",
            offset: 14,
          })
            .setLngLat(vesselLngLat(latest, portByIdRef.current) ?? pos)
            .setHTML(vesselPopupHtml(latest))
            .addTo(map);
        });
      }

      rec.marker.setLngLat(pos);
      if (v.mode === "SEA" && rec.svg) {
        const from = portById.get(v.from_port);
        const to = portById.get(v.to_port);
        if (from && to) {
          rec.svg.style.transform = `rotate(${bearingDeg(
            [from.lon, from.lat],
            [to.lon, to.lat],
          )}deg)`;
        }
      }
    }

    for (const [id, rec] of vesselMarkersRef.current) {
      if (!seen.has(id)) {
        rec.marker.remove();
        vesselMarkersRef.current.delete(id);
      }
    }
  }, [ready, snapshot, portById]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />

      {!episode && (
        <div className="pointer-events-none absolute left-3 top-3 z-10">
          <span className="chip inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-low">
            <Anchor size={11} strokeWidth={1.75} className="text-faint" />
            no live episode
          </span>
        </div>
      )}

      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-1.5 right-2 z-10 text-[9px] text-faint/80 transition-colors hover:text-low"
      >
        © Protomaps © OpenStreetMap
      </a>

      {/* MapLibre popup chrome — restyled into the Dock palette. */}
      <style>{`
        .dock-popup .maplibregl-popup-content {
          background: rgba(15, 20, 42, 0.96);
          border: 1px solid rgba(152, 162, 226, 0.14);
          border-radius: 12px;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
          padding: 10px 12px;
          color: #eef1ff;
          font-family: var(--font-sans);
          backdrop-filter: blur(6px);
        }
        .dock-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip { border-top-color: rgba(15, 20, 42, 0.96); }
        .dock-popup.maplibregl-popup-anchor-top .maplibregl-popup-tip { border-bottom-color: rgba(15, 20, 42, 0.96); }
        .dock-popup.maplibregl-popup-anchor-left .maplibregl-popup-tip { border-right-color: rgba(15, 20, 42, 0.96); }
        .dock-popup.maplibregl-popup-anchor-right .maplibregl-popup-tip { border-left-color: rgba(15, 20, 42, 0.96); }
        .maplibregl-ctrl-attrib { background: transparent; }
      `}</style>
    </div>
  );
}
