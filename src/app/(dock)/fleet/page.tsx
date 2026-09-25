import type { Metadata } from "next";
import { FleetScreen } from "./FleetScreen";

export const metadata: Metadata = {
  title: "Dock — Fleet",
  description:
    "The ops floor — live fleet positions, decisions, and settlement",
};

export default function FleetPage() {
  return <FleetScreen />;
}
