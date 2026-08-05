import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Silences a Turbopack warning: it was finding an unrelated
  // package-lock.json further up the Windows user directory and treating
  // it as an ambiguous workspace root.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
