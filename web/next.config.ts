import type { NextConfig } from "next";

const engine = process.env.NIGHTFILL_ENGINE_URL ?? "http://127.0.0.1:8788";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/engine/:path*", destination: `${engine}/:path*` }];
  },
};

export default nextConfig;
