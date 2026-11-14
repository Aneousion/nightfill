import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engine = process.env.NIGHTFILL_ENGINE_URL ?? "http://127.0.0.1:8788";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const nextConfig: NextConfig = {
  outputFileTracingRoot: root,
  async rewrites() {
    return [{ source: "/engine/:path*", destination: `${engine}/:path*` }];
  },
};

export default nextConfig;
