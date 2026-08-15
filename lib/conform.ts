// The conformance engine. See CLAUDE.md phase 4.
//
// Pure functions only: no fetch, no clock reads, no React. `now` is passed in.
// That is what makes every verdict in here reproducible from a track buffer and
// a timestamp, and it is the reason the whole file is testable.
//
// The comments explain the aviation, not the TypeScript. A reader who knows how
// an aircraft flies and nothing about React should be able to follow it.

import type { Assessment, Clearance, TrackSample, Verdict } from './types.ts'
import { formatAltitude, formatFeet, formatHeading } from './format.ts'

/**
 * Every threshold in one place, so they are visible and tunable. See CLAUDE.md
 * section 4.6. These are judgement calls, not regulation: they are set to be
 * loose enough that normal flying does not trip them, because a monitor that
 * cries wolf gets switched off.
 */
export const TOL = {
  responseWindowSec: 20, // time allowed to start reacting
  evalWindowSec: 120, // time allowed to complete
  altLevelBandFt: 200, // counts as level at assigned altitude
  altBustFt: 400, // passed through the assigned altitude
  vsRespondingFpm: 300, // vertical rate that counts as a real response
  vsLevelFpm: 300, // below this counts as level
  hdgToleranceDeg: 10, // counts as established on assigned heading
  spdToleranceKt: 15, // ground speed, wind makes this loose
  magVarDeg: 13, // east variation at SFO in 2026
  staleTrackSec: 15,

  // Beyond section 4.6, and tunable for the same reason the rest are.
  hdgRespondingDeg: 5, // turn that counts as having started the turn
  spdRespondingKt: 5, // speed change that counts as a real response
  driftMultiplier: 2, // how far off an established value counts as having left it
} as const

/**
 * Whether a clearance is still being monitored.
 *
 * COMPLIED counts as open. An altitude assignment does not stop applying the
 * moment the aircraft reaches it -- "climb and maintain one zero thousand" says
 * maintain, and an aircraft that levels at 10,000 and then drifts off it is the
 * single event most worth catching. Closing the clearance on arrival would make
 * a level bust invisible.
 *
 * DEVIATED is terminal. It records something that happened at a time, and the
 * evidence attached to it is the evidence as it stood then. Letting it reopen
 * would rewrite the finding every two seconds.
 */
export function isOpen(verdict: Verdict): boolean {
  return (
    verdict === 'PENDING' ||
    verdict === 'COMPLYING' ||
    verdict === 'UNKNOWN' ||
    verdict === 'COMPLIED'
  )
}

/** Headings run 001 through 360. North is 360, never 0. */
export function normaliseHeading(deg: number): number {
  const x = ((deg % 360) + 360) % 360
  return x === 0 ? 360 : x
}

/**
 * Convert a true bearing to magnetic.
 *
 * ATC issues headings in degrees MAGNETIC. ADS-B reports track in degrees TRUE.
 * At SFO the variation is about 13 degrees east in 2026, so magnetic = true - 13.
 * Skipping this makes every heading verdict wrong by 13 degrees, which is inside
 * a 10 degree tolerance often enough to look almost right, which is worse than
 * being obviously broken.
 */
export function magneticFromTrue(trueDeg: number, magVarDeg: number = TOL.magVarDeg): number {
  return normaliseHeading(trueDeg - magVarDeg)
}

/**
 * Signed shortest angular difference from `from` to `to`, in (-180, 180].
 * Positive is a right turn, negative is a left turn. Going from 350 to 010 is
 * a 20 degree right turn, not a 340 degree left one.
 *
 * A reciprocal heading is exactly 180 degrees either way round, so there is no
 * shorter direction and no correct sign. It is reported as +180 by convention,
 * matching how a controller would issue it ("turn right heading ...") rather
 * than leaving the sign to depend on floating point.
 */
export function angularDifference(from: number, to: number): number {
  const d = ((to - from + 540) % 360) - 180
  return d === -180 ? 180 : d
}

/**
 * An altitude, written the way the system writes it: FL350 above the transition
 * altitude, 10,000 ft below it.
 */
const alt = formatAltitude

/**
 * A vertical DISTANCE, which is never a flight level. "3,000 ft to run" is a gap
 * between two altitudes, and FL030 would be nonsense.
 */
const gap = formatFeet

/** Vertical rate as a signed rate, or "level". */
function rate(vs: number): string {
  if (Math.abs(vs) < TOL.vsLevelFpm) return 'level'
  return `${vs > 0 ? 'climbing' : 'descending'} at ${Math.abs(Math.round(vs)).toLocaleString('en-US')} fpm`
}

/** Three digit heading, the way it is written on a strip: 090, not 90. */
const hdg = formatHeading

/**
 * Which heading to judge against, and how much to trust it.
 *
 * `nav_heading` is the heading selected in the autopilot, already magnetic, and
 * it is what the crew actually dialled in. It is the right answer when it is
 * broadcast. Otherwise we fall back to ground track corrected for variation,
 * which is NOT the same thing: wind blows the aircraft sideways, so a crab of
 * 10 degrees in a strong crosswind will show as a track 10 degrees off an
 * accurately flown heading. The caveat rides along in the detail line so nobody
 * reads a track based verdict as if it were a heading measurement.
 */
export type HeadingReading = { deg: number; source: 'nav' | 'track' }

export function headingOf(s: TrackSample): HeadingReading | null {
  if (s.navHeading !== null) return { deg: normaliseHeading(s.navHeading), source: 'nav' }
  if (s.trackTrue !== null) return { deg: magneticFromTrue(s.trackTrue), source: 'track' }
  return null
}

/**
 * Judge one clearance against the track recorded since it was issued.
 *
 * `now` is a parameter rather than a clock read so the verdict is a pure
 * function of its inputs, and so replay mode and the tests can drive time.
 */
export function evaluate(clearance: Clearance, buffer: TrackSample[], now: number): Assessment {
  // A clearance that has already been closed keeps its answer. Re-judging a
  // superseded clearance against the aircraft's later behaviour is exactly how
  // an amended instruction turns into a false deviation.
  if (!isOpen(clearance.status)) {
    return { verdict: clearance.status, detail: clearance.detail || describeClosed(clearance.status) }
  }

  const latest = buffer.length > 0 ? buffer[buffer.length - 1] : null
  if (!latest) {
    return { verdict: 'UNKNOWN', detail: 'no track data received since the clearance was issued' }
  }

  // Two different ways the picture can go stale: the receiver has not heard a
  // position from the aircraft recently (seen_pos), or we have not received a
  // snapshot at all (our own sample is old). Either way there is nothing to
  // judge, and a stale track is reported as UNKNOWN and never as a deviation.
  if (latest.seenPosSec > TOL.staleTrackSec) {
    return {
      verdict: 'UNKNOWN',
      detail: `track stale, ${Math.round(latest.seenPosSec)} s since the last position report`,
    }
  }
  const sampleAgeSec = (now - latest.ts) / 1000
  if (sampleAgeSec > TOL.staleTrackSec) {
    return {
      verdict: 'UNKNOWN',
      detail: `no update for ${Math.round(sampleAgeSec)} s, holding last known position`,
    }
  }

  const elapsedSec = (now - clearance.issuedAt) / 1000
  // Once the aircraft has reached the assigned value, the question stops being
  // "is it responding" and becomes "is it still there". The response window no
  // longer applies, and leaving the value is a deviation rather than a slow
  // reaction.
  const established = clearance.status === 'COMPLIED'

  switch (clearance.constraint.kind) {
    case 'ALTITUDE':
      return evaluateAltitude(clearance.constraint, latest, elapsedSec, established)
    case 'HEADING':
      return evaluateHeading(clearance.constraint, buffer, latest, elapsedSec, established)
    case 'SPEED':
      return evaluateSpeed(clearance.constraint, buffer, latest, elapsedSec, established)
  }
}

function describeClosed(v: Verdict): string {
  if (v === 'SUPERSEDED') return 'superseded by a later clearance of the same kind'
  return v.toLowerCase()
}

/** Seconds left in the response window, never negative. */
function remaining(elapsedSec: number): number {
  return Math.max(0, Math.ceil(TOL.responseWindowSec - elapsedSec))
}

// ---------------------------------------------------------------- altitude

function evaluateAltitude(
  c: Extract<Clearance['constraint'], { kind: 'ALTITUDE' }>,
  latest: TrackSample,
  elapsedSec: number,
  established: boolean,
): Assessment {
  const altFt = latest.altFt
  if (altFt === null) {
    return { verdict: 'UNKNOWN', detail: 'no altitude reported, aircraft may be on the surface' }
  }
  const vs = latest.vsFpm ?? 0
  const assigned = c.targetFt
  const errorFt = assigned - altFt // positive means the aircraft is below the assigned altitude
  const insideBand = Math.abs(errorFt) <= TOL.altLevelBandFt
  const isLevel = Math.abs(vs) < TOL.vsLevelFpm

  // "maintain" is a different question from "climb" or "descend". There is no
  // response window, because the aircraft is not being asked to start doing
  // anything, only to keep doing it.
  // An established climb or descent becomes a hold: it was told to climb AND
  // MAINTAIN, and it is now on the maintain half of that.
  if (c.direction === 'hold' || established) {
    if (Math.abs(errorFt) > TOL.altBustFt) {
      return {
        verdict: 'DEVIATED',
        detail: `assigned to maintain ${alt(assigned)}, aircraft has left it and is at ${alt(altFt)}, ${rate(vs)}`,
      }
    }
    if (insideBand && isLevel) {
      return { verdict: 'COMPLIED', detail: `holding ${alt(altFt)}, assigned ${alt(assigned)}` }
    }
    return {
      verdict: 'COMPLYING',
      detail: `assigned to maintain ${alt(assigned)}, currently ${alt(altFt)} and ${rate(vs)}`,
    }
  }

  const commandedSign = c.direction === 'up' ? 1 : -1
  const verb = c.direction === 'up' ? 'climb' : 'descent'

  // Busted through. Checked before anything else, because an aircraft that has
  // gone past its assigned altitude and is still going is the single event
  // most worth surfacing, whatever the response window says.
  const overshootFt = commandedSign * (altFt - assigned)
  if (overshootFt > TOL.altBustFt) {
    return {
      verdict: 'DEVIATED',
      detail: `assigned ${verb} to ${alt(assigned)}, aircraft passed through it and is at ${alt(altFt)}, ${rate(vs)}`,
    }
  }

  // Established. This can be true on the very first sample, when the aircraft
  // already happened to be at the assigned altitude.
  if (insideBand && isLevel) {
    return {
      verdict: 'COMPLIED',
      detail: `level ${alt(altFt)}, assigned ${alt(assigned)}, inside the ${TOL.altLevelBandFt} ft band`,
    }
  }

  const respondingCorrectly = commandedSign * vs >= TOL.vsRespondingFpm
  const respondingWrongWay = commandedSign * vs <= -TOL.vsRespondingFpm

  // Moving away from the assigned altitude. This is the case worth reporting
  // and it does not wait for the response window: the aircraft is not slow to
  // react, it is going the other way.
  if (respondingWrongWay) {
    return {
      verdict: 'DEVIATED',
      detail: `assigned ${verb} to ${alt(assigned)}, aircraft is ${rate(vs)} at ${alt(altFt)}`,
    }
  }

  if (respondingCorrectly) {
    return {
      verdict: 'COMPLYING',
      detail: `${rate(vs)} through ${alt(altFt)}, ${gap(Math.abs(errorFt))} to run to the assigned ${alt(assigned)}`,
    }
  }

  // Not moving. Inside the response window this is normal: the crew is reading
  // back, the autopilot is being reset, the aircraft has inertia.
  if (elapsedSec <= TOL.responseWindowSec) {
    return {
      verdict: 'PENDING',
      detail: `assigned ${verb} to ${alt(assigned)}, no vertical response yet at ${alt(altFt)}, ${remaining(elapsedSec)} s of the ${TOL.responseWindowSec} s window remaining`,
    }
  }

  // Past the response window and still not moving. Distinguish never started
  // from stopped short, because they are different operational events.
  const startedButStopped = Math.abs(errorFt) > TOL.altLevelBandFt && elapsedSec > TOL.evalWindowSec
  if (startedButStopped) {
    return {
      verdict: 'DEVIATED',
      detail: `assigned ${verb} to ${alt(assigned)}, aircraft is level at ${alt(altFt)}, ${gap(Math.abs(errorFt))} short after ${Math.round(elapsedSec)} s`,
    }
  }
  return {
    verdict: 'DEVIATED',
    detail: `assigned ${verb} to ${alt(assigned)}, no vertical response within ${TOL.responseWindowSec} s, still ${rate(vs)} at ${alt(altFt)}`,
  }
}

// ----------------------------------------------------------------- heading

function evaluateHeading(
  c: Extract<Clearance['constraint'], { kind: 'HEADING' }>,
  buffer: TrackSample[],
  latest: TrackSample,
  elapsedSec: number,
  established: boolean,
): Assessment {
  const current = headingOf(latest)
  if (!current) {
    return { verdict: 'UNKNOWN', detail: 'no heading or track reported' }
  }
  const assigned = c.targetDegMag
  const caveat =
    current.source === 'nav'
      ? 'from the selected heading the autopilot is broadcasting'
      : `from ground track corrected ${TOL.magVarDeg}° for magnetic variation, which is not heading in a crosswind`

  const errorDeg = angularDifference(current.deg, assigned)
  const offDeg = Math.abs(errorDeg)

  // Already established on this heading, so the only question left is whether
  // it has wandered off. The band for leaving is wider than the band for
  // arriving, so a heading held on the edge of tolerance does not flicker
  // between two verdicts every couple of seconds.
  if (established) {
    if (offDeg <= TOL.hdgToleranceDeg) {
      return {
        verdict: 'COMPLIED',
        detail: `holding heading ${hdg(current.deg)}°, assigned ${hdg(assigned)}°, ${caveat}`,
      }
    }
    if (offDeg > TOL.hdgToleranceDeg * TOL.driftMultiplier) {
      return {
        verdict: 'DEVIATED',
        detail: `established on ${hdg(assigned)}° and has since drifted to ${hdg(current.deg)}°, ${Math.round(offDeg)}° off, ${caveat}`,
      }
    }
    return {
      verdict: 'COMPLYING',
      detail: `drifting off the assigned ${hdg(assigned)}°, now ${hdg(current.deg)}°, ${Math.round(offDeg)}° off, ${caveat}`,
    }
  }

  // Established on the assigned heading. Checked first: how the aircraft got
  // there stops mattering once it is there.
  if (offDeg <= TOL.hdgToleranceDeg) {
    return {
      verdict: 'COMPLIED',
      detail: `established heading ${hdg(current.deg)}°, assigned ${hdg(assigned)}°, ${Math.abs(Math.round(errorDeg))}° off, ${caveat}`,
    }
  }

  // How far the aircraft has actually turned since the clearance, summed
  // sample to sample so that a turn through north reads as a few degrees and
  // not as a 350 degree turn the other way.
  const turnedDeg = cumulativeTurn(buffer)

  if (c.turn !== 'shortest' && turnedDeg !== null) {
    const commandedSign = c.turn === 'right' ? 1 : -1
    const wrongWayDeg = -commandedSign * turnedDeg
    if (wrongWayDeg >= TOL.hdgRespondingDeg) {
      return {
        verdict: 'DEVIATED',
        detail: `assigned a ${c.turn} turn to ${hdg(assigned)}°, aircraft turned ${Math.round(wrongWayDeg)}° the wrong way and is heading ${hdg(current.deg)}°, ${caveat}`,
      }
    }
  }

  const turning = turnedDeg !== null && Math.abs(turnedDeg) >= TOL.hdgRespondingDeg
  if (turning) {
    const dir = turnedDeg! > 0 ? 'right' : 'left'
    return {
      verdict: 'COMPLYING',
      detail: `turning ${dir} through ${hdg(current.deg)}°, ${Math.abs(Math.round(errorDeg))}° to run to the assigned ${hdg(assigned)}°, ${caveat}`,
    }
  }

  if (elapsedSec <= TOL.responseWindowSec) {
    return {
      verdict: 'PENDING',
      detail: `assigned ${turnDescription(c.turn)} ${hdg(assigned)}°, no turn yet from ${hdg(current.deg)}°, ${remaining(elapsedSec)} s of the ${TOL.responseWindowSec} s window remaining`,
    }
  }
  return {
    verdict: 'DEVIATED',
    detail: `assigned ${turnDescription(c.turn)} ${hdg(assigned)}°, no turn within ${TOL.responseWindowSec} s, still heading ${hdg(current.deg)}°, ${caveat}`,
  }
}

function turnDescription(turn: 'left' | 'right' | 'shortest'): string {
  if (turn === 'left') return 'a left turn to'
  if (turn === 'right') return 'a right turn to'
  return 'heading'
}

/**
 * Total turn since the clearance was issued, in degrees, signed right positive.
 *
 * Summed between consecutive samples rather than taken end to end, so a turn
 * that passes through north is measured as the small turn it was, and so a turn
 * of more than 180 degrees is not read as a smaller turn the other way.
 * Returns null when there is not enough heading data to say.
 */
function cumulativeTurn(buffer: TrackSample[]): number | null {
  const headings = buffer.map(headingOf).filter((h): h is { deg: number; source: 'nav' | 'track' } => h !== null)
  if (headings.length < 2) return null
  let total = 0
  for (let i = 1; i < headings.length; i++) {
    total += angularDifference(headings[i - 1].deg, headings[i].deg)
  }
  return total
}

// ------------------------------------------------------------------- speed

function evaluateSpeed(
  c: Extract<Clearance['constraint'], { kind: 'SPEED' }>,
  buffer: TrackSample[],
  latest: TrackSample,
  elapsedSec: number,
  established: boolean,
): Assessment {
  const gs = latest.gsKt
  if (gs === null) {
    return { verdict: 'UNKNOWN', detail: 'no ground speed reported' }
  }
  const assigned = c.targetKt
  // Ground speed is not indicated airspeed. ATC assigns IAS, ADS-B broadcasts
  // ground speed, and the difference is the wind, which at altitude is often
  // 80 kt or more. This caveat belongs on every speed verdict.
  const caveat = 'judged on ground speed, so wind makes this approximate'
  const errorKt = assigned - gs
  const offKt = Math.abs(errorKt)

  // Already at the assigned speed, so the question is whether it has drifted
  // off. As with heading, leaving takes a wider band than arriving did.
  if (established) {
    if (offKt <= TOL.spdToleranceKt) {
      return {
        verdict: 'COMPLIED',
        detail: `holding ${Math.round(gs)} kt against an assigned ${assigned} kt, ${caveat}`,
      }
    }
    if (offKt > TOL.spdToleranceKt * TOL.driftMultiplier) {
      return {
        verdict: 'DEVIATED',
        detail: `was established at ${assigned} kt and is now ${Math.round(gs)} kt, ${Math.round(offKt)} kt off, ${caveat}`,
      }
    }
    return {
      verdict: 'COMPLYING',
      detail: `drifting off the assigned ${assigned} kt, now ${Math.round(gs)} kt, ${caveat}`,
    }
  }

  if (offKt <= TOL.spdToleranceKt) {
    return {
      verdict: 'COMPLIED',
      detail: `${Math.round(gs)} kt against an assigned ${assigned} kt, inside ${TOL.spdToleranceKt} kt, ${caveat}`,
    }
  }

  // Which way the aircraft was asked to go. Taken from the speed at the moment
  // of the clearance, because the constraint itself only carries a target.
  const first = buffer.find((s) => s.gsKt !== null)
  const initialGs = first?.gsKt ?? gs
  const commandedSign = Math.sign(assigned - initialGs) || Math.sign(errorKt)
  const changeKt = gs - initialGs
  const movingRightWay = commandedSign * changeKt >= TOL.spdRespondingKt
  const movingWrongWay = commandedSign * changeKt <= -TOL.spdRespondingKt
  const verb = commandedSign < 0 ? 'reduction' : 'increase'

  if (movingWrongWay) {
    return {
      verdict: 'DEVIATED',
      detail: `assigned a speed ${verb} to ${assigned} kt, aircraft has gone from ${Math.round(initialGs)} to ${Math.round(gs)} kt, ${caveat}`,
    }
  }

  if (movingRightWay) {
    return {
      verdict: 'COMPLYING',
      detail: `${Math.round(gs)} kt and ${commandedSign < 0 ? 'slowing' : 'accelerating'} toward the assigned ${assigned} kt, ${Math.abs(Math.round(errorKt))} kt to run, ${caveat}`,
    }
  }

  if (elapsedSec <= TOL.responseWindowSec) {
    return {
      verdict: 'PENDING',
      detail: `assigned a speed ${verb} to ${assigned} kt, still ${Math.round(gs)} kt, ${remaining(elapsedSec)} s of the ${TOL.responseWindowSec} s window remaining`,
    }
  }
  return {
    verdict: 'DEVIATED',
    detail: `assigned a speed ${verb} to ${assigned} kt, no change within ${TOL.responseWindowSec} s, still ${Math.round(gs)} kt, ${caveat}`,
  }
}

// -------------------------------------------------------------- superseding

/**
 * Close any open clearance that the incoming one replaces.
 *
 * A controller who amends an instruction has not been disobeyed. When a second
 * altitude clearance is issued to the same aircraft, the first one stops being
 * a question anyone is asking, and it must be closed as SUPERSEDED rather than
 * left open to fail on the response window it can no longer meet. Without this
 * the board fills with false deviations the moment anyone amends anything,
 * which is most of what real ATC does.
 *
 * Only clearances of the same kind for the same aircraft are affected: a speed
 * assignment does not cancel an altitude assignment, they run together.
 *
 * Returns the list with the affected entries closed. Adding the incoming
 * clearance is the caller's job, so this cannot insert it twice.
 */
export function supersede(clearances: Clearance[], incoming: Clearance): Clearance[] {
  return clearances.map((c) => {
    if (c.id === incoming.id) return c
    if (c.hex !== incoming.hex) return c
    if (c.constraint.kind !== incoming.constraint.kind) return c
    if (!isOpen(c.status)) return c
    return {
      ...c,
      status: 'SUPERSEDED' as const,
      detail: `superseded by a later ${incoming.constraint.kind.toLowerCase()} clearance for ${incoming.resolvedCallsign}`,
    }
  })
}
