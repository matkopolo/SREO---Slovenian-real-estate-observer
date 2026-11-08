import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // Browser requests stay same-origin; Docker resolves the API service internally.
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://real-estate-api:8080/api/:path*" }];
  },
};

export default nextConfig;
