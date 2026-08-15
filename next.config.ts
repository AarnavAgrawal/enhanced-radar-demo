import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The replay recording is read at runtime with fs rather than imported, so
  // Next's file tracing cannot see it and would leave it out of the serverless
  // bundle. Without this, ?replay=1 works locally and 500s on Vercel, which is
  // the worst possible place to find out.
  //
  // Tracing it rather than importing it keeps the several megabytes out of the
  // client bundle and off every request that is not replaying.
  outputFileTracingIncludes: {
    '/api/traffic': ['./data/replay-sfo.json'],
  },
}

export default nextConfig
