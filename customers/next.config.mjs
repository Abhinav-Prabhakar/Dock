/* Static export in production (Docker/nginx serves the `out/` files with no
   Node runtime); a dev-only /api rewrite so `npm run dev` can talk to the
   backend without nginx in front of it. Rewrites and `output: 'export'`
   can't coexist, so the real static export only happens when DOCK_EXPORT=1
   (set by `npm run build`, see package.json and ui/Dockerfile). */
const isExport = process.env.DOCK_EXPORT === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/customers',
  trailingSlash: true,
  images: { unoptimized: true },
  // the intake pages and the dashboard are hand-built imperative modules
  // (physics loop, maplibre, canvas) that assume a page mounts once —
  // React 18 Strict Mode's dev-only double-invoke of effects would load
  // every <script> twice and start two physics loops.
  reactStrictMode: false,
};

if (isExport) {
  nextConfig.output = 'export';
} else {
  const apiOrigin = process.env.DOCK_API_ORIGIN || 'http://localhost:8080';
  nextConfig.rewrites = async () => [
    // DockAPI (shared/api.js) always calls the root-relative /api/*, not
    // <basePath>/api/* — opt this rewrite out of basePath prefixing so it
    // still matches.
    { source: '/api/:path*', destination: `${apiOrigin}/api/:path*`, basePath: false },
  ];
}

export default nextConfig;
