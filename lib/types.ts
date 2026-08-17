// Shared data model.

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
  /** Client receive time, ms. Stamped by the browser, not the server. */
  ts: number
}

/**
 * What a clearance requires the aircraft to do. One clearance carries exactly
 * one constraint; an amendment is a new clearance that supersedes the old one.
 */
export type Constraint =
  | { kind: 'ALTITUDE'; targetFt: number; direction: 'up' | 'down' | 'hold' }
  | { kind: 'HEADING'; targetDegMag: number; turn: 'left' | 'right' | 'shortest' }
  | { kind: 'SPEED'; targetKt: number }

/** A snapshot of every aircraft in the polling radius at one instant. */
export type TrafficSnapshot = {
  aircraft: Aircraft[]
  /** Which upstream actually served this snapshot, or the committed recording. */
  source: 'adsb.lol' | 'airplanes.live' | 'replay'
  /** Server fetch time, ms since epoch. */
  fetchedAt: number
}

/** Where playback has got to, present only when serving a recording. */
export type ReplayPosition = {
  frame: number
  frames: number
  recordedAt: string
}

/** What the /api/traffic route returns, success or failure. */
export type TrafficResponse =
  | ({ ok: true; replay?: ReplayPosition } & TrafficSnapshot)
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

/**
 * One position report retained for a clearance, sampled from the live feed.
 *
 * A lighter thing than an Aircraft: the conformance engine needs the numbers
 * that move and the timestamp, not the identity, which is already on the
 * clearance.
 */
export type TrackSample = {
  ts: number // client receive time, ms
  altFt: number | null
  vsFpm: number | null
  gsKt: number | null
  trackTrue: number | null // degrees TRUE
  navHeading: number | null // degrees MAGNETIC, autopilot selected, when broadcast
  seenPosSec: number
}

/**
 * What the engine concluded. Deliberately not a boolean: "we cannot tell" is a
 * distinct and frequent answer, and collapsing it into "no deviation" is how a
 * monitoring tool quietly stops being trustworthy.
 */
export type Verdict =
  | 'PENDING' // issued, waiting for the first response
  | 'COMPLYING' // moving the right way, not there yet
  | 'COMPLIED' // established at the assigned value
  | 'DEVIATED' // moving the wrong way, or busted through
  | 'SUPERSEDED' // a newer clearance of the same kind replaced this one
  | 'UNKNOWN' // track lost, stale data, or ambiguous callsign

/** A verdict plus the evidence for it. The detail line is never empty. */
export type Assessment = {
  verdict: Verdict
  detail: string
}

/** One synthetic clearance issued at one aircraft. */
export type Clearance = {
  id: string
  hex: string // resolved aircraft, the stable key
  spokenText: string // exactly what the user typed or said
  spokenCallsign: string // "united 328"
  resolvedCallsign: string // "UAL328"
  registration: string | null // "N27239"
  constraint: Constraint
  issuedAt: number
  status: Verdict
  detail: string // one human readable line, always populated
  history: TrackSample[] // samples since issue, for the sparkline
  /**
   * The clearance this one replaced, when it amended an earlier instruction.
   * The old strip is pulled from the bay rather than left to clutter it, so
   * this is what remains of it.
   */
  amendedFrom: Constraint | null
}

/** One recorded snapshot in the replay file. */
export type ReplayFrame = {
  /** Milliseconds after the recording started. */
  offsetMs: number
  aircraft: Aircraft[]
}

/** The committed replay recording, played back when the network cannot be trusted. */
export type ReplayFile = {
  recordedAt: string
  intervalMs: number
  frames: ReplayFrame[]
}
