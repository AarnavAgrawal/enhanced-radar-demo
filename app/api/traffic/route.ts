// Server proxy to adsb.lol. Exists so the browser never calls the upstream
// directly (CORS) and so one cached snapshot serves every connected client.

import { NextResponse } from 'next/server'
import { fetchTraffic, SFO } from '@/lib/adsb'
import type { TrafficResponse, TrafficSnapshot } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Last snapshot that actually contained aircraft.
 *
 * Two jobs. It de-duplicates upstream hits when several clients poll at 2s, and
 * it means a single failed fetch shows a stale badge instead of blanking the
 * board mid-demo. Module scope is fine here: one process, no persistence needed.
 */
let lastGood: TrafficSnapshot | null = null

/** Serve the cache rather than re-hitting upstream inside this window. */
const CACHE_TTL_MS = 1500

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const lat = Number(searchParams.get('lat') ?? SFO.lat)
  const lon = Number(searchParams.get('lon') ?? SFO.lon)
  const dist = Number(searchParams.get('dist') ?? SFO.radiusNm)

  if (lastGood && Date.now() - lastGood.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, ...lastGood } satisfies TrafficResponse)
  }

  try {
    lastGood = await fetchTraffic(lat, lon, dist)
    return NextResponse.json({ ok: true, ...lastGood } satisfies TrafficResponse)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // Hold the last known picture. The client shows how old it is; it does not
    // get a blank screen because one poll timed out on expo wifi.
    if (lastGood) {
      return NextResponse.json({ ok: true, ...lastGood } satisfies TrafficResponse)
    }
    return NextResponse.json(
      { ok: false, error, fetchedAt: Date.now() } satisfies TrafficResponse,
      { status: 502 },
    )
  }
}
