/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async headers() {
    const privateHeaders = [
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ];
    return [
      { source: "/agent-comm-sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
      ...["/verify-email", "/reset-password", "/confirm-password-change", "/forgot-password", "/resend-verification", "/api/auth/:path*"].map(source => ({ source, headers: privateHeaders })),
    ];
  },
};
module.exports = nextConfig;
