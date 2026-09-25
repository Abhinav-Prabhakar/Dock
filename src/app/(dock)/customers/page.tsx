import type { Metadata } from "next";
import { CustomersScreen } from "./CustomersScreen";

export const metadata: Metadata = {
  title: "Dock — Customers",
  description: "The booking desk — live offers, real settlements",
};

export default function CustomersPage() {
  return <CustomersScreen />;
}
