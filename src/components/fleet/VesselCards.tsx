"use client";

import type { LucideIcon } from "lucide-react";
import {
  Anchor,
  ArrowDownToLine,
  CalendarClock,
  Container,
  Fuel,
  Gauge,
  Navigation,
  Route,
  Ship,
  Snowflake,
} from "lucide-react";
import type { EpisodeVessel, Vessel } from "@/lib/api";
import { useEpisode } from "@/components/dock/EpisodeProvider";
import { Empty, MeterBar, Pill } from "@/components/dock/ui";

/* Fleet spec sheet — one graphics-first card per vessel.
   Specs are icon+numeral cells (no wordy labels); a live block overlays
   onboard/load, a speed dot-track, and the loop mini-map when an episode
   is running. Without an episode the cards degrade to faint "—" values. */

/** Bookable own-lift share of nameplate capacity. */
const bookableTeu = (v: Vessel) => v.capacity_teu * 0.45 * 0.88;

const fmtInt = (v: number) => Math.round(v).toLocaleString("en-US");

/** Icon + numeral + faint unit — the spec-strip atom. */
function SpecCell({
  icon: Icon,
  value,
  unit,
  note,
}: {
  icon: LucideIcon;
  value: string;
  unit: string;
  note?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <Icon size={12} className="shrink-0 self-center text-faint" strokeWidth={1.75} />
      <span className="font-display text-[13px] font-medium leading-none text-hi tabular-nums">
        {value}
      </span>
      <span className="text-[9px] text-faint">{unit}</span>
      {note && <span className="text-[8.5px] leading-none text-faint/80">{note}</span>}
    </div>
  );
}

/** min..max track with a service-speed tick and a live position dot. */
function SpeedTrack({
  min,
  service,
  max,
  speed,
}: {
  min: number;
  service: number;
  max: number;
  speed: number | null;
}) {
  const span = max - min || 1;
  const pos = (v: number) =>
    `${Math.min(100, Math.max(0, ((v - min) / span) * 100)).toFixed(1)}%`;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] text-faint tabular-nums">{min}</span>
      <div className="relative h-1 flex-1 rounded-full bg-ink">
        <span
          className="absolute -top-[3px] h-[7px] w-px bg-faint/80"
          style={{ left: pos(service) }}
          title={`service ${service} kt`}
        />
        {speed !== null && (
          <span
            className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_7px_rgba(124,135,242,0.9)] transition-[left] duration-500"
            style={{ left: pos(speed) }}
          />
        )}
      </div>
      <span className="text-[9px] text-faint tabular-nums">{max}</span>
    </div>
  );
}

/** ">"-separated loop as a dashed chain of port chips, current stop in accent. */
function LoopChain({ loop, current }: { loop: string; current: string | null }) {
  const stops = loop.split(">").filter(Boolean);
  return (
    <div className="flex items-center overflow-hidden">
      {stops.map((pid, i) => {
        const active = pid === current;
        return (
          <span key={`${pid}-${i}`} className="flex min-w-0 shrink-0 items-center">
            {i > 0 && (
              <span className="mx-1 h-px w-2.5 shrink-0 border-t border-dashed border-edge" />
            )}
            <span
              className={`rounded-full border px-1.5 py-px text-[9px] font-medium tracking-wide ${
                active
                  ? "border-accent/60 bg-accent/15 text-accent-soft shadow-[0_0_8px_rgba(124,135,242,0.25)]"
                  : "chip text-low"
              }`}
            >
              {pid}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const BAYS = 40; // 10 cols × 4 rows

/** Compact bay grid filled left-to-right with the live load fraction. */
function StowageGrid({ fill, plugs }: { fill: number; plugs: number }) {
  const lit = Math.round(Math.min(1, Math.max(0, fill)) * BAYS);
  return (
    <div className="flex items-center gap-2">
      <div className="grid h-8 flex-1 grid-cols-10 grid-rows-4 gap-[3px]">
        {Array.from({ length: BAYS }, (_, i) => (
          <span
            key={i}
            className={`rounded-[1.5px] transition-colors duration-500 ${
              i < lit ? "bg-loaded" : "bg-ink"
            }`}
          />
        ))}
      </div>
      {plugs > 0 && (
        <span
          className="chip flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] text-low tabular-nums"
          title={`${plugs} reefer plugs`}
        >
          <Snowflake size={9} className="text-loaded-soft" strokeWidth={1.75} />
          {plugs}
        </span>
      )}
    </div>
  );
}

function VesselCard({
  v,
  live,
}: {
  v: Vessel;
  live: EpisodeVessel | undefined;
}) {
  const bookable = bookableTeu(v);
  const onboard = live?.onboard_teu ?? null;
  const atSea = live?.mode === "SEA";
  const inPort = live?.mode === "PORT";
  const currentPort = live
    ? inPort
      ? live.port ?? live.to_port
      : live.from_port
    : null;

  return (
    <div className="panel-flat flex-1 rounded-2xl p-3.5">
      {/* header: name · id · live status */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="truncate font-display text-[14px] font-semibold tracking-tight text-hi">
            {v.name}
          </h3>
          <span className="chip shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium text-low">
            {v.vessel_id}
          </span>
        </div>
        {atSea ? (
          <Pill tone="accent" icon={Navigation}>
            sea
          </Pill>
        ) : inPort ? (
          <Pill tone="ok" icon={Anchor}>
            port
          </Pill>
        ) : (
          <Pill tone="neutral">idle</Pill>
        )}
      </div>

      {/* spec strip: icon + number micro-grid */}
      <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-2">
        <SpecCell icon={Container} value={fmtInt(v.capacity_teu)} unit="teu" />
        <SpecCell icon={Snowflake} value={fmtInt(v.reefer_plugs)} unit="plugs" />
        <SpecCell
          icon={Gauge}
          value={`${v.min_speed_kt}–${v.max_speed_kt}`}
          unit="kt"
          note={`svc ${v.service_speed_kt}`}
        />
        <SpecCell icon={CalendarClock} value={String(v.age_years)} unit="yr" />
        <SpecCell icon={ArrowDownToLine} value={v.draft_m.toFixed(1)} unit="m" />
        <SpecCell
          icon={Fuel}
          value={v.fuel_a_tpd.toFixed(1)}
          unit="t/d"
          note={`+${v.fuel_b_tpd.toFixed(3)}v²`}
        />
      </div>

      {/* live block — real values underway, faint "—" when no episode */}
      <div className="mt-3 space-y-2 border-t border-edge-soft pt-2.5">
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[9px] uppercase tracking-[0.14em] text-faint">
              onboard
            </span>
            {onboard !== null ? (
              <span className="font-display text-[11px] text-hi tabular-nums">
                {fmtInt(onboard)}
                <span className="text-faint"> / {fmtInt(bookable)} teu</span>
              </span>
            ) : (
              <span className="text-[11px] text-faint">—</span>
            )}
          </div>
          <MeterBar
            pct={onboard !== null ? onboard / bookable : 0}
            tone="loaded"
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SpeedTrack
              min={v.min_speed_kt}
              service={v.service_speed_kt}
              max={v.max_speed_kt}
              speed={live ? live.speed_kt : null}
            />
          </div>
          <span className="shrink-0 font-display text-[11px] text-hi tabular-nums">
            {live ? live.speed_kt.toFixed(1) : "—"}
            <span className="text-[9px] text-faint"> kt</span>
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-[10px]">
          <Route size={11} className="shrink-0 text-accent" strokeWidth={1.75} />
          {inPort ? (
            <>
              <span className="font-medium text-hi">{live.port ?? live.to_port}</span>
              <span className="text-faint">berthed</span>
            </>
          ) : atSea ? (
            <>
              <span className="text-mid">{live.from_port}</span>
              <span className="text-faint">→</span>
              <span className="font-medium text-hi">{live.to_port}</span>
              <span className="ml-auto text-faint tabular-nums">
                {Math.round(live.progress * 100)}%
              </span>
            </>
          ) : (
            <span className="text-faint">—</span>
          )}
        </div>
      </div>

      {/* loop mini-map */}
      <div className="mt-3 border-t border-edge-soft pt-2.5">
        <LoopChain loop={v.loop} current={currentPort} />
      </div>

      {/* mini stowage */}
      <div className="mt-2.5">
        <StowageGrid
          fill={onboard !== null ? onboard / bookable : 0}
          plugs={v.reefer_plugs}
        />
      </div>
    </div>
  );
}

export function VesselCards() {
  const { vessels, snapshot } = useEpisode();

  if (vessels.length === 0) {
    return (
      <div className="panel-flat rounded-2xl">
        <Empty icon={Ship}>fleet specs unavailable</Empty>
      </div>
    );
  }

  /* Horizontal rail — cards are direct children so the screen's
     [&>*>*]:min-w-[270px] + overflow-x-auto turns this into a card strip. */
  return (
    <div className="flex gap-3">
      {vessels.map((v) => (
        <VesselCard
          key={v.vessel_id}
          v={v}
          live={snapshot?.vessels.find((sv) => sv.vessel_id === v.vessel_id)}
        />
      ))}
    </div>
  );
}
