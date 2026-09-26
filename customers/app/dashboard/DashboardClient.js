'use client';
/* ============================================================
   DashboardClient — the fleet dashboard, live orders wired up
   ------------------------------------------------------------
   Same "keep the imperative modules" approach as the intake
   pages (see components/LegacyPage.js), with one addition: before
   dashboard/script.js runs, this wires window.DockOrdersStore to
   the shared ordersStore (lib/ordersStore.js) and starts its 15s
   visibility-aware poll. script.js's boot() reads window.
   DockOrdersStore, does its first fetch through it, and
   subscribes for every later push — a Booking Desk action, the
   poll, or another tab's booking — repainting the register,
   wall, totals, chart and detail card in place. See
   public/dashboard/script.js's "LIVE ORDERS" section and
   lib/ordersStore.js.
   ============================================================ */
import { useEffect } from 'react';
import LegacyPage from '../../components/LegacyPage';
import { ordersStore } from '../../lib/ordersStore';
import html from '../markup/dashboard';

const CSS = [
  'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'style.css',
  '../shared/offers.css',
  'desk.css',
];
const SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  '../shared/api.js',
  '../shared/offers.js',
  'script.js',
  'desk.js',
];

export default function DashboardClient() {
  useEffect(() => () => {
    // belt-and-braces: also torn down inside onBeforeScripts' own effect
    // ordering isn't guaranteed across components, so this is the
    // authoritative cleanup for the polling timer.
    ordersStore.stopPolling();
    if (window.DockOrdersStore === ordersStore) delete window.DockOrdersStore;
  }, []);

  // wiring window.DockOrdersStore must happen BEFORE dashboard/script.js is
  // fetched, so it has to run inside LegacyPage's own effect (child effects
  // fire before a parent's) rather than in a separate effect here.
  const wireStore = () => {
    window.DockOrdersStore = ordersStore;
    ordersStore.startPolling(15000);
  };

  return <LegacyPage html={html} css={CSS} scripts={SCRIPTS} onBeforeScripts={wireStore} />;
}
