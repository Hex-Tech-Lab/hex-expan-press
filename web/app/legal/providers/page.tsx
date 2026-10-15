import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Service providers — ExpanPress",
  robots: { index: false, follow: false },
};

const providers = [
  {
    name: "Paddle.com",
    role: "Merchant of Record: checkout, payment, tax, refunds and buyer billing support",
    data: "Name, email, country, order details, payment data (held by Paddle, not by ExpanPress)",
  },
  {
    name: "Supabase",
    role: "Database and sign-in for creator accounts and access records",
    data: "Account email, order and access records, support messages",
  },
  {
    name: "Vercel",
    role: "Website hosting and delivery",
    data: "IP address, request and device data",
  },
  {
    name: "Sentry",
    role: "Error monitoring, so we can fix faults",
    data: "Technical data from errors, such as IP address, browser and device details",
  },
];

export default function ProvidersPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px", lineHeight: 1.65 }}>
      <p style={{ fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase", color: "#E8622C", fontWeight: 600 }}>
        Legal
      </p>
      <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 8 }}>Service providers</h1>
      <p style={{ fontSize: 13, color: "#6E5F53", marginBottom: 28 }}>Last updated: 15 October 2026</p>
      <p style={{ fontSize: 14.5, marginBottom: 16 }}>
        These providers process personal data on ExpanPress&apos;s behalf. This list is updated whenever a provider is added.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #EADFD1" }}>
            <th style={{ padding: "8px 6px" }}>Provider</th>
            <th style={{ padding: "8px 6px" }}>Role</th>
            <th style={{ padding: "8px 6px" }}>Data processed</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.name} style={{ borderBottom: "1px solid #EADFD1", verticalAlign: "top" }}>
              <td style={{ padding: "8px 6px", fontWeight: 600 }}>{p.name}</td>
              <td style={{ padding: "8px 6px" }}>{p.role}</td>
              <td style={{ padding: "8px 6px" }}>{p.data}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
