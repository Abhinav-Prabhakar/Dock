import { redirect } from "next/navigation";

// The booking desk scene lives at /customers now — keep the old route working.
export default function BookingDeskRedirect() {
  redirect("/customers");
}
