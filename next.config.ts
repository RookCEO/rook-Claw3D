import type { NextConfig } from "next";
import path from "node:path";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      // rook fork: relaxed so the Hermes dashboard (different port on the
      // same tailnet host) can embed /office in an iframe. The Claw3D
      // server is tailnet-only via `tailscale serve`, so * is acceptable
      // — clickjacking from the public internet is not a threat model.
      "frame-ancestors *",
      "img-src 'self' data: blob: http: https:",
      "font-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline' https:",
      // 'unsafe-eval' is required by Next.js dev mode (source maps, HMR).
      // In production it is dropped — React and Three.js do not need eval.
      // 'wasm-unsafe-eval' is required in both modes: the office scene loads
      // a WebAssembly module (used by the Phaser+Box2D physics step). Without
      // it the renderer throws "WebAssembly.instantiate() violates CSP" and
      // the WebGL canvas loses its context.
      ...(process.env.NODE_ENV !== "production"
        ? ["script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:"]
        : ["script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:"]),
      // connect-src is intentionally broad: gateway URLs are user-configured
      // at runtime and cannot be enumerated at build time.
      // Restrict further when a fixed deployment target is known.
      "connect-src 'self' ws: wss: http: https:",
      "media-src 'self' blob: data: http: https:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  // rook fork: X-Frame-Options dropped intentionally. SAMEORIGIN can't be
  // expanded to allow the dashboard origin (different port); CSP
  // frame-ancestors supersedes it for modern browsers.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), browsing-topics=()",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "same-origin",
  },
];

if (process.env.NODE_ENV === "production") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  });
}

const nextConfig: NextConfig = {
  // rook fork: the dashboard reverse-proxies /claw3d-app/* → port 3001 so the
  // tailnet only needs port 9119 open. basePath tells Next.js to prefix every
  // route and asset URL accordingly, so the proxied client-side router stays
  // happy.
  basePath: "/claw3d-app",
  assetPrefix: "/claw3d-app",
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
