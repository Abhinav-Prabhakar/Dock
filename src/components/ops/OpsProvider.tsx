"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type PlanView = "top" | "side";
export type ZoomPanel = "flow" | "balance" | null;

interface OpsContextValue {
  query: string;
  setQuery: (q: string) => void;
  /** selected sidebar container id (drives card ring + details) */
  selected: string | null;
  setSelected: (id: string | null) => void;
  view: PlanView;
  setView: (v: PlanView) => void;
  /** container ids locally "optimized" via the card action */
  resolved: Set<string>;
  resolve: (id: string) => void;
  alertsOpen: boolean;
  setAlertsOpen: (v: boolean) => void;
  alertAcked: boolean;
  ackAlerts: () => void;
  zoom: ZoomPanel;
  setZoom: (z: ZoomPanel) => void;
  railCollapsed: boolean;
  toggleRail: () => void;
}

const OpsContext = createContext<OpsContextValue | null>(null);

export function OpsProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<PlanView>("top");
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertAcked, setAlertAcked] = useState(false);
  const [zoom, setZoom] = useState<ZoomPanel>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);

  const value = useMemo<OpsContextValue>(
    () => ({
      query,
      setQuery,
      selected,
      setSelected,
      view,
      setView,
      resolved,
      resolve: (id) => setResolved((s) => new Set(s).add(id)),
      alertsOpen,
      setAlertsOpen,
      alertAcked,
      ackAlerts: () => {
        setAlertAcked(true);
        setAlertsOpen(false);
      },
      zoom,
      setZoom,
      railCollapsed,
      toggleRail: () => setRailCollapsed((c) => !c),
    }),
    [query, selected, view, resolved, alertsOpen, alertAcked, zoom, railCollapsed],
  );

  return <OpsContext.Provider value={value}>{children}</OpsContext.Provider>;
}

export function useOps() {
  const ctx = useContext(OpsContext);
  if (!ctx) throw new Error("useOps must be used within an OpsProvider");
  return ctx;
}
