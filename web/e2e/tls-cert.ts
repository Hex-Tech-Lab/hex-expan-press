// Per-run self-signed certificate for the HTTPS twin of the E2E mock (Firma and Supabase over TLS).
// Runs before the mock starts (playwright.config.ts). The app trusts it only through NODE_EXTRA_CA_CERTS,
// which playwright.config.ts sets for the app process; nothing is added to the system trust store.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { E2E } from "./constants";

mkdirSync(E2E.tlsDir, { recursive: true });
execFileSync(
  "openssl",
  [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(E2E.tlsDir, "key.pem"),
    "-out", join(E2E.tlsDir, "cert.pem"),
    "-days", "2",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ],
  { stdio: "ignore" },
);
console.log(`[tls-cert] wrote ${join(E2E.tlsDir, "cert.pem")}`);
