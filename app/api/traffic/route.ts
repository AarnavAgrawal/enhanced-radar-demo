// Server proxy to adsb.lol. Exists so the browser never calls the upstream
// directly (CORS) and so one cached snapshot serves every connected client.
//
// With ?replay=1 it serves a committed recording instead, which is the version
// that works when the venue wifi does not.

import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchTraffic, SFO } from '@/lib/adsb'
import { frameAt, restamp } from '@/lib/replay'
import type { ReplayFile, TrafficResponse, TrafficSnapshot } from '@/lib/types'

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

/** The recording, read once and kept in memory. */
let replayFile: ReplayFile | null = null

async function loadReplay(): Promise<ReplayFile> {
  if (replayFile) return replayFile
  const file = path.join(process.cwd(), 'data', 'replay-sfo.json')
  replayFile = JSON.parse(await readFile(file, 'utf8')) as ReplayFile
  return replayFile
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const lat = Number(searchParams.get('lat') ?? SFO.lat)
  const lon = Number(searchParams.get('lon') ?? SFO.lon)
  const dist = Number(searchParams.get('dist') ?? SFO.radiusNm)

  if (searchParams.get('replay') === '1') {
    try {
      const replay = await loadReplay()
      const now = Date.now()
      // Playback position comes from the client, as milliseconds since it
      // started replaying. The server keeps no clock of its own: module scope
      // does not survive a hot reload in dev or a cold start on Vercel, and a
      // playhead that resets on every request never leaves the first frame.
      const elapsedMs = Number(searchParams.get('t') ?? 0)
      const { aircraft, index } = frameAt(replay, Number.isFinite(elapsedMs) ? elapsedMs : 0)
      return NextResponse.json({
        ok: true,
        // Recorded positions carry their original timestamps, which would read
        // as hours stale. Restamping is what makes the engine judge them.
        aircraft: restamp(aircraft, now),
        source: 'replay',
        fetchedAt: now,
        replay: { frame: index, frames: replay.frames.length, recordedAt: replay.recordedAt },
      } satisfies TrafficResponse)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { ok: false, error: `replay unavailable: ${error}`, fetchedAt: Date.now() } satisfies TrafficResponse,
        { status: 503 },
      )
    }
  }

  if (lastGood && Date.now() - lastGood.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, ...lastGood } satisfies TrafficResponse)
  }

  try {
    lastGood = await fetchTraffic(lat, lon, dist)
    return NextResponse.json({ ok: true, ...lastGood } satisfies TrafficResponse)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // Hold the last known picture. The client shows how old it is; it does not
    // get a blank screen because one poll timed out on a flaky network.
    if (lastGood) {
      return NextResponse.json({ ok: true, ...lastGood } satisfies TrafficResponse)
    }
    return NextResponse.json(
      { ok: false, error, fetchedAt: Date.now() } satisfies TrafficResponse,
      { status: 502 },
    )
  }
}
