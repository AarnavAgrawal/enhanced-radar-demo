// How aviation numbers are written down. Pure functions.
//
// Getting these wrong is the kind of thing a pilot spots in the first two
// seconds, so they live in one place and are used everywhere a number reaches
// a human.

/**
 * The US transition altitude.
 *
 * Below 18,000 ft an aircraft flies an ALTITUDE, set against the local
 * altimeter setting, and it is written in feet: 10,000. At and above 18,000 ft
 * everyone sets 29.92 inHg and flies a FLIGHT LEVEL, written FL350. They are
 * the same measurement taken against a different reference, which is why the
 * same aircraft is "ten thousand" one minute and "flight level two four zero"
 * the next.
 *
 * Rendering 35,000 ft as "35,000 ft" is not wrong so much as it is not how
 * anyone in the system writes it.
 */
export const TRANSITION_ALTITUDE_FT = 18000

/** An altitude as it is written: "FL350" above the transition altitude, "10,000 ft" below. */
export function formatAltitude(ft: number): string {
  const rounded = Math.round(ft)
  if (rounded >= TRANSITION_ALTITUDE_FT) {
    return `FL${String(Math.round(rounded / 100)).padStart(3, '0')}`
  }
  return `${rounded.toLocaleString('en-US')} ft`
}

/**
 * A vertical distance, which is never a flight level.
 *
 * "3,000 ft to run" is a gap between two altitudes, not an altitude, and
 * writing it as FL030 would be nonsense. Kept separate from formatAltitude so
 * the distinction cannot be lost by accident.
 */
export function formatFeet(ft: number): string {
  return `${Math.round(ft).toLocaleString('en-US')} ft`
}

/**
 * Altitude as it appears in a radar data block: hundreds of feet, three digits.
 * 35,000 ft is "350" and 8,500 ft is "085".
 */
export function altitudeTag(ft: number): string {
  return String(Math.round(ft / 100)).padStart(3, '0')
}

/** A heading, three digits, the way it is written on a strip: 090, not 90. */
export function formatHeading(deg: number): string {
  const x = ((Math.round(deg) % 360) + 360) % 360
  return String(x === 0 ? 360 : x).padStart(3, '0')
}

/** Vertical rate, signed, in feet per minute. */
export function formatVerticalRate(fpm: number): string {
  const r = Math.round(fpm)
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('en-US')}`
}
