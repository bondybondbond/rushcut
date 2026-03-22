import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@ffprobe-installer/ffprobe'],
  async redirects() {
    return [
      { source: '/configure/:path*', destination: '/editor/:path*', permanent: false },
      { source: '/preview/:path*', destination: '/', permanent: false },
      { source: '/download/:path*', destination: '/', permanent: false },
    ];
  },
};

export default nextConfig;
