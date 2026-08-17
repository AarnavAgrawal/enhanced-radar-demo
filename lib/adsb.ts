// Fetch and normalise live ADS-B snapshots from the adsb.lol v2 API.
//
// This module is the only place that knows the shape of the upstream JSON.
// Everything downstream sees `Aircraft`, which is flat, typed, and unit-explicit.

import type { Aircraft, TrafficSnapshot } from './types.ts'

/** SFO field reference point, and the radius we watch around it. */
export const SFO = { lat: 37.6188, lon: -122.375, radiusNm: 40 } as const

/** Raw adsb.lol v2 aircraft record. Only the fields we consume are declared. */
type RawAircraft = {
  hex?: string
  flight?: string
  r?: string
  t?: string
  /** Feet, or the literal string "ground" when the aircraft is on the surface. */
  alt_baro?: number | string
  /** Barometric vertical rate, fpm. Not always broadcast. */
  baro_rate?: number
  /** Geometric vertical rate, fpm. Used only when baro_rate is absent. */
  geom_rate?: number
  gs?: number
  /** Ground track, degrees TRUE. */
  track?: number
  /** Autopilot selected heading, degrees magnetic. Only some airframes send it. */
  nav_heading?: number
  lat?: number
  lon?: number
  seen_pos?: number
}

type RawResponse = { ac?: RawAircraft[]; aircraft?: RawAircraft[]; now?: number }

/** Coerce to a finite number, or null. Upstream sends nulls, strings and absent keys. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Normalise one raw record.
 *
 * Returns null for records with no ICAO address or no position -- a track we
 * cannot key or cannot place is not useful to us, and letting it through would
 * put a blank row on the board.
 */
export function normaliseAircraft(raw: RawAircraft, receivedAt: number): Aircraft | null {
  const hex = raw.hex?.trim().toLowerCase()
  const lat = num(raw.lat)
  const lon = num(raw.lon)
  if (!hex || lat === null || lon === null) return null

  // `flight` is the FMS flight ID, space padded to 8 characters by the ADS-B
  // frame format. Untrimmed it will never compare equal to anything.
  const callsignRaw = raw.flight?.trim()
  const callsign = callsignRaw && callsignRaw.length > 0 ? callsignRaw.toUpperCase() : null

  // alt_baro is the string "ground" for surface traffic, not a number. Those
  // aircraft have no meaningful altitude, so altFt stays null and the caller
  // reads onGround instead of comparing against a fake zero.
  const onGround = raw.alt_baro === 'ground'
  const altFt = onGround ? null : num(raw.alt_baro)

  // Prefer the barometric rate: it is what the altimeter and therefore ATC's
  // altitude readout follow. Geometric (GNSS) rate is a reasonable stand-in
  // when baro is not broadcast, but the two disagree in non-standard pressure.
  const vsFpm = num(raw.baro_rate) ?? num(raw.geom_rate)

  return {
    hex,
    callsign,
    registration: raw.r?.trim().toUpperCase() || null,
    type: raw.t?.trim().toUpperCase() || null,
    altFt,
    onGround,
    vsFpm,
    gsKt: num(raw.gs),
    trackTrue: num(raw.track),
    navHeading: num(raw.nav_heading),
    lat,
    lon,
    // A missing seen_pos means we cannot vouch for freshness, so treat it as
    // stale rather than fresh. Downstream marks stale tracks UNKNOWN, never
    // as a deviation.
    seenPosSec: num(raw.seen_pos) ?? Number.POSITIVE_INFINITY,
    // Server receive time. The browser overwrites this with its own clock on
    // arrival, because staleness is judged against the browser's clock and the
    // two must not be mixed. See the poll handler in app/page.tsx.
    ts: receivedAt,
  }
}

/** Normalise a whole upstream payload, dropping unusable records. */
export function normaliseSnapshot(body: RawResponse, receivedAt: number): Aircraft[] {
  const list = body.ac ?? body.aircraft ?? []
  const out: Aircraft[] = []
  for (const raw of list) {
    const a = normaliseAircraft(raw, receivedAt)
    if (a) out.push(a)
  }
  return out
}

/**
 * Fetch a snapshot from adsb.lol, falling back to airplanes.live.
 *
 * airplanes.live began requiring per-project approval, and returns 403 with a
 * "contact us" body to unregistered callers, so the fallback is off unless
 * AIRPLANES_LIVE_ENABLED=1. Real resilience comes from the last-known-good
 * cache in the API route, not from this fallback.
 *
 * Server side only -- calling adsb.lol from the browser would trip CORS.
 */
export async function fetchTraffic(
  lat: number = SFO.lat,
  lon: number = SFO.lon,
  radiusNm: number = SFO.radiusNm,
): Promise<TrafficSnapshot> {
  const sources: Array<{ name: TrafficSnapshot['source']; url: string }> = [
    { name: 'adsb.lol', url: `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${radiusNm}` },
  ]
  if (process.env.AIRPLANES_LIVE_ENABLED === '1') {
    sources.push({
      name: 'airplanes.live',
      url: `https://api.airplanes.live/v2/point/${lat}/${lon}/${radiusNm}`,
    })
  }

  let lastError = 'no sources configured'
  for (const source of sources) {
    try {
      const res = await fetch(source.url, {
        headers: { accept: 'application/json', 'user-agent': 'enhanced-radar-demo/0.1' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        lastError = `${source.name} returned HTTP ${res.status}`
        continue
      }
      const receivedAt = Date.now()
      const body = (await res.json()) as RawResponse
      const aircraft = normaliseSnapshot(body, receivedAt)
      // An empty list from a healthy upstream is possible but suspicious at
      // SFO. Treat it as a miss so we fall through rather than blanking the board.
      if (aircraft.length === 0) {
        lastError = `${source.name} returned no aircraft`
        continue
      }
      return { aircraft, source: source.name, fetchedAt: receivedAt }
    } catch (err) {
      lastError = `${source.name} threw: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  throw new Error(lastError)
}
