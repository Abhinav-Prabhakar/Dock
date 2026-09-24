// Container colouring modes shared by the 3D vessel, the metrics legend and the 2D stowage profile.
import { CATEGORIES, PORTS } from './config.js';

export const COLOR_MODES = {
  livery: { label: 'Livery' },
  weight: { label: 'Weight' },
  pod:    { label: 'Port' },
  type:   { label: 'Type' },
};

const WEIGHT_STOPS = [
  [0, [44, 123, 182]], [0.3, [120, 190, 220]], [0.5, [236, 232, 170]], [0.72, [248, 168, 88]], [1, [214, 40, 40]],
];
export const WEIGHT_RANGE = [2, 30];

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

export function weightColor(t) {
  const k = Math.min(1, Math.max(0, (t - WEIGHT_RANGE[0]) / (WEIGHT_RANGE[1] - WEIGHT_RANGE[0])));
  for (let i = 1; i < WEIGHT_STOPS.length; i++) {
    if (k <= WEIGHT_STOPS[i][0]) {
      const [k0, c0] = WEIGHT_STOPS[i - 1], [k1, c1] = WEIGHT_STOPS[i];
      const f = (k - k0) / (k1 - k0);
      return hex(c0.map((v, j) => v + (c1[j] - v) * f));
    }
  }
  return hex(WEIGHT_STOPS[WEIGHT_STOPS.length - 1][1]);
}

const portColor = new Map(PORTS.map((p) => [p.code, p.color]));

export function boxColor(box, mode) {
  switch (mode) {
    case 'weight': return weightColor(box.weight);
    case 'pod': return portColor.get(box.pod) || '#999999';
    case 'type': return CATEGORIES[box.category]?.color || '#999999';
    default: return box.color;
  }
}

// Legend entries for a mode: [{ label, color }] or a gradient descriptor for weight.
export function legendFor(mode) {
  if (mode === 'weight') return { gradient: WEIGHT_STOPS.map(([k, c]) => [k, hex(c)]), range: WEIGHT_RANGE, unit: 't' };
  if (mode === 'pod') return { items: PORTS.map((p) => ({ label: p.name, color: p.color })) };
  if (mode === 'type') return { items: Object.values(CATEGORIES).map((c) => ({ label: c.label, color: c.color })) };
  return { items: [{ label: 'Carrier colours', color: '#c43a7a' }] };
}
