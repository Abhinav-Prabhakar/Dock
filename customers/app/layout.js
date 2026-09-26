export const metadata = {
  title: 'MERIDIAN LINE — Customers',
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%2316202a'/%3E%3Crect x='12' y='34' width='18' height='12' rx='2' fill='%234f9dde'/%3E%3Crect x='34' y='34' width='18' height='12' rx='2' fill='%23e35fb0'/%3E%3Crect x='23' y='20' width='18' height='12' rx='2' fill='%235fe39a'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
