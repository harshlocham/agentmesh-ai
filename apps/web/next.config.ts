import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotEnv } from "dotenv";

// Ensure the web app can run from monorepo root env files in Turbo workspaces.
const rootEnvPath = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnvPath)) {
  loadDotEnv({ path: rootEnvPath, override: false });
}

const nextConfig: NextConfig = {
  transpilePackages: ["@chat/auth", "@chat/services", "@chat/db"],
  images: {
    domains: ["lh3.googleusercontent.com", "ik.imagekit.io"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ik.imagekit.io",
      },
    ],
  },
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@chat/services": resolve(process.cwd(), "../../packages/services"),
      "@chat/db": resolve(process.cwd(), "../../packages/db"),
    };

    return config;
  },
};

export default nextConfig;