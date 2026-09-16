import type { Metadata } from "next";
import { BookingDesk } from "@/components/customers/BookingDesk";

export const metadata: Metadata = {
  title: "Dock — Customers",
  description: "The booking desk: live customer offers at the counter",
};

export default function CustomersPage() {
  return <BookingDesk />;
}
