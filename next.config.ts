import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Sent with every response. The app is never shown inside another site's frame (clickjacking),
  // never leaks its addresses to other sites, and browsers do not guess file types.
  // The full Content-Security-Policy (with a nonce per page) is set in src/proxy.ts, report-only for now (D-70).
  // HSTS: only on https (staging/production). It starts at one day so a mistake on the first deploy cannot lock
  // browsers to https for long; raise HSTS_MAX_AGE (seconds) once staging has run cleanly (RUNBOOK).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          ...(process.env.APP_URL?.startsWith("https://")
            ? [{ key: "Strict-Transport-Security", value: `max-age=${Number.parseInt(process.env.HSTS_MAX_AGE ?? "86400", 10) || 86400}` }]
            : []),
        ],
      },
      {
        // the public check page answers for a specific code: never kept by a browser or a shared cache
        source: "/verify",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
