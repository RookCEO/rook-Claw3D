const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const resolveStudioProxyGatewayUrl = (upstreamGatewayUrl?: string): string => {
  const raw = typeof upstreamGatewayUrl === "string" ? upstreamGatewayUrl.trim() : "";
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (LOOPBACK_HOSTS.has(parsed.hostname)) {
        return raw;
      }
      // rook fork: when Studio is embedded behind a reverse proxy (same
      // origin as the browser), connect directly to the upstream URL
      // instead of routing through the Studio's own /api/gateway/ws
      // (which only exists when running `node server/index.js`, not the
      // `next start` runtime we use in production).
      if (typeof window !== "undefined") {
        const here = window.location;
        if (parsed.host === here.host) {
          return raw;
        }
      }
    } catch {
      // Fall through to the Studio proxy for malformed or non-URL values.
    }
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.host;
  return `${protocol}://${host}/api/gateway/ws`;
};

