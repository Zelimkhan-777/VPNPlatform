import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const target = process.env.WEB_API_PROXY_TARGET;

    if (!target) {
      return [];
    }

    return [
      {
        source: '/api/:path*',
        destination: `${target}/:path*`,
      },
    ];
  },
};

export default nextConfig;
