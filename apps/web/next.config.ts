import type { NextConfig } from 'next';
import path from 'node:path';

import { requireHttpOrigin } from './api-proxy-target.mjs';

const apiProxyTarget = requireHttpOrigin(process.env.WEB_API_PROXY_TARGET);

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiProxyTarget}/:path*`,
      },
    ];
  },
};

export default nextConfig;
