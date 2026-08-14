// Shared data model. See CLAUDE.md section 5.
//
// Only the types phases 1 and 2 actually use live here. Constraint / Clearance /
// Verdict arrive in phases 3 and 4 alongside the code that consumes them.

/**
 * A single ADS-B position report, normalised out of the adsb.lol v2 payload.
 *
 * `hex` (the ICAO 24 bit address) is the primary key everywhere. It is burned
 * into the transponder and does not change. `callsign` is the flight ID the
 * crew typed into the FMS this leg, and it is reused by a different airframe
 * tomorrow, so it is never a stable key.
 */
export type Aircraft = {
  hex: string
  callsign: string | null // trimmed `flight`, e.g. "UAL328"
  registration: string | null // `r`, the tail number, e.g. "N27239"
  type: string | null // `t`, ICAO type code, e.g. "B739"
  altFt: number | null // null when the aircraft reports "ground"
  onGround: boolean
  vsFpm: number | null // signed, feet per minute
  gsKt: number | null // ground speed, knots
  trackTrue: number | null // ground track, degrees TRUE (not magnetic, not heading)
  navHeading: number | null // autopilot selected heading, degrees magnetic, when broadcast
  lat: number
  lon: number
  seenPosSec: number // seconds since last position update
  ts: number // client receive time, ms
}

/** A snapshot of every aircraft in the polling radius at one instant. */
export type TrafficSnapshot = {
  aircraft: Aircraft[]
  /** Which upstream actually served this snapshot. */
  source: 'adsb.lol' | 'airplanes.live'
  /** Server fetch time, ms since epoch. */
  fetchedAt: number
}

/** What the /api/traffic route returns, success or failure. */
export type TrafficResponse =
  | ({ ok: true } & TrafficSnapshot)
  | { ok: false; error: string; fetchedAt: number }

/**
 * Result of resolving free text to a live aircraft. Three outcomes, and
 * ambiguity is never silently collapsed into a guess -- an ATC tool that picks
 * one of two similar callsigns for you is worse than one that asks.
 */
export type Resolution =
  | { outcome: 'exact'; spokenCallsign: string; resolvedCallsign: string; aircraft: Aircraft }
  | { outcome: 'ambiguous'; spokenCallsign: string; resolvedCallsign: string | null; candidates: Aircraft[] }
  | { outcome: 'none'; spokenCallsign: string; resolvedCallsign: string | null; reason: string }
