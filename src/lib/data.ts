export type CellStatus = "reserved" | "loaded" | "pending" | "empty";

export interface BayCell {
  id?: string;
  serial?: string;
  status: CellStatus;
}

export interface SidebarContainer {
  id: string;
  platform: string;
  status: string;
  weight: string;
  tone: "highlight" | "critical" | "minor" | "optimized";
}

export const sidebarContainers: SidebarContainer[] = [
  { id: "CNT-A14", platform: "B2", status: "Load Warning", weight: "21.3", tone: "highlight" },
  { id: "CNT-D07", platform: "D4", status: "Critical", weight: "19.8", tone: "critical" },
  { id: "CNT-C22", platform: "A1", status: "Minor", weight: "17.5", tone: "minor" },
  { id: "CNT-B09", platform: "C3", status: "Optimized", weight: "22.1", tone: "optimized" },
];

// Top-view bay plan. Two rows visible; ids/serials match the reference mock.
export const bayRows: BayCell[][] = [
  [
    { id: "CNT-C05", serial: "N°1870", status: "reserved" },
    { id: "CNT-C03", serial: "N°1534", status: "reserved" },
    { id: "CNT-C02", serial: "N°1602", status: "loaded" },
    { status: "empty" },
    { id: "CNT-C07", serial: "N°1927", status: "reserved" },
    { id: "CNT-C09", serial: "N°1566", status: "loaded" },
    { id: "CNT-C01", serial: "N°1932", status: "pending" },
    { id: "CNT-C15", serial: "N°1841", status: "loaded" },
    { status: "empty" },
  ],
  [
    { id: "CNT-C13", serial: "N°1994", status: "pending" },
    { id: "CNT-C19", serial: "N°1965", status: "loaded" },
    { id: "CNT-C12", serial: "N°1858", status: "reserved" },
    { id: "CNT-C06", serial: "N°1981", status: "pending" },
    { id: "CNT-C21", serial: "N°1850", status: "loaded" },
    { id: "CNT-C17", serial: "N°1915", status: "reserved" },
    { id: "CNT-C08", serial: "N°1972", status: "pending" },
    { status: "empty" },
    { id: "CNT-C24", serial: "N°1890", status: "reserved" },
  ],
];

// Deterministic pseudo-random dot field for the loading-flow scatter.
export const flowDots: { x: number; y: number; tone: "hi" | "mid" | "low" }[] = (() => {
  const dots: { x: number; y: number; tone: "hi" | "mid" | "low" }[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 66; i++) {
    const x = 14 + i * 10.6 + rand() * 6;
    const y = 6 + rand() * 26;
    const r = rand();
    dots.push({ x, y, tone: r > 0.72 ? "hi" : r > 0.38 ? "mid" : "low" });
  }
  return dots;
})();
