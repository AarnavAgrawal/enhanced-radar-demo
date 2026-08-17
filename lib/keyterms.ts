// Build the Deepgram keyterm list from the live traffic picture.
// Pure functions; the traffic list is passed in.
//
// This is the part of the voice path worth talking about. A general speech
// model has no reason to prefer "Speedbird" over "speed bird", or to hear
// "niner" as a digit rather than a name. But we already know which aircraft are
// within 40 nm right now, so we can tell the recogniser which callsigns are
// physically possible before it listens. That is what you would do in
// production; it is not a demo trick. The list is rebuilt on every request so
// it tracks the traffic picture rather than a snapshot from startup.

import type { Aircraft } from './types.ts'
import { TELEPHONY } from './telephony.ts'

/**
 * ICAO prefix back to the telephony name a controller would say.
 *
 * TELEPHONY is many-to-one (both "republic" and "brickyard" reach RPA), so the
 * reverse map keeps the first spelling for each prefix, which is the telephony
 * name because the table lists that first.
 */
const SPOKEN_BY_ICAO: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [spoken, icao] of Object.entries(TELEPHONY)) {
    out[icao] ??= spoken
  }
  return out
})()

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner']
const TEENS = [
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** A number under 100, spoken: 45 -> "forty five", 5 -> "five", 12 -> "twelve". */
function underHundred(n: number): string {
  if (n < 10) return ONES[n]
  if (n < 20) return TEENS[n - 10]
  const t = TENS[Math.floor(n / 10)]
  const o = n % 10
  return o === 0 ? t : `${t} ${ONES[o]}`
}

/**
 * A flight number the way it is actually said on frequency.
 *
 * Controllers group flight numbers rather than reading every digit: 328 is
 * "three twenty eight", 1812 is "eighteen twelve". A zero in the trailing pair
 * becomes "oh", so 305 is "three oh five". This is a convention rather than a
 * rule and it varies by operator, which is why the digit form is offered as a
 * keyterm too and why the parser accepts both.
 */
export function spokenFlightNumber(digits: string): string {
  const n = digits.replace(/\D/g, '')
  if (n.length === 0) return ''
  if (n.length <= 2) return underHundred(Number(n))
  if (n.length === 3) {
    const tail = Number(n.slice(1))
    const head = ONES[Number(n[0])]
    return tail < 10 ? `${head} oh ${ONES[tail]}` : `${head} ${underHundred(tail)}`
  }
  if (n.length === 4) {
    const a = Number(n.slice(0, 2))
    const b = Number(n.slice(2))
    return b < 10 ? `${underHundred(a)} oh ${ONES[b]}` : `${underHundred(a)} ${underHundred(b)}`
  }
  return n.split('').map((d) => ONES[Number(d)]).join(' ')
}

/**
 * The instruction vocabulary. Small, fixed, and always included: these words
 * appear in every clearance, so they earn their tokens more reliably than any
 * individual callsign does.
 *
 * The ICAO digit pronunciations are here because they are the whole reason
 * `numerals` is turned off. "Niner" has to survive as a word for the parser's
 * normaliser to read it; formatted into a 9 it is indistinguishable from a
 * spoken "nine" and the ICAO vocabulary stops being visible at all.
 */
const INSTRUCTION_TERMS = [
  'climb', 'descend', 'maintain', 'turn', 'left', 'right', 'heading', 'fly',
  'reduce', 'increase', 'speed', 'knots', 'flight level', 'thousand', 'hundred',
  'niner', 'tree', 'fife',
]

/**
 * Word budget for the whole keyterm list.
 *
 * Deepgram caps keyterms at "500 tokens across all keyterms", and rejects the
 * entire request with a 400 when that is exceeded -- which would take the voice
 * path down mid demo rather than degrade it. The cap is a budget across the
 * list, not a count of terms, so 193 aviation callsigns at four or five words
 * each blows it comfortably while looking like a modest list.
 *
 * Their tokens are not our words. Measured against the live API: 280 words was
 * accepted and 313 was rejected, so their tokenizer is splitting aviation
 * vocabulary into roughly 1.8 subword tokens per word -- unsurprising, since
 * "niner" and "skywest" are not words a general tokenizer has a unit for.
 *
 * 260 leaves real headroom, and still covers around 35 aircraft nearest the
 * field, which is far more than anyone talks to in a demo.
 */
export const KEYTERM_TOKEN_BUDGET = 260

/**
 * Words, counted by whitespace. An approximation of Deepgram's tokens, which is
 * why KEYTERM_TOKEN_BUDGET is set well under their limit rather than at it.
 */
function tokenCount(term: string): number {
  return term.trim().split(/\s+/).filter(Boolean).length
}

/** Great circle distance in nautical miles, for prioritising the nearest traffic. */
function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export type KeytermList = {
  terms: string[]
  tokens: number
  /** How many live aircraft made it into the list, for the debug panel. */
  aircraftCovered: number
  /** How many were dropped for want of budget. */
  aircraftDropped: number
}

/**
 * Build the keyterm list for the current traffic picture, inside the budget.
 *
 * Priority is by how much the recogniser needs the help, and by how likely the
 * words are to actually be spoken:
 *
 *  1. The instruction vocabulary, which appears in every single clearance.
 *  2. Telephony names for operators actually in the picture. A name nobody is
 *     about to say is spending budget that a nearby callsign could use.
 *  3. Live callsigns, nearest first, because the aircraft being worked are the
 *     ones close to the field, and they are the words a general model is most
 *     likely to mangle.
 */
export function buildKeyterms(
  traffic: Aircraft[],
  centre: { lat: number; lon: number },
  budget: number = KEYTERM_TOKEN_BUDGET,
): KeytermList {
  const terms: string[] = []
  const seen = new Set<string>()
  let tokens = 0

  /** Add a term if it fits. Returns whether it did. */
  const add = (t: string): boolean => {
    const clean = t.trim()
    if (!clean) return false
    const key = clean.toLowerCase()
    if (seen.has(key)) return false
    const cost = tokenCount(clean)
    if (tokens + cost > budget) return false
    seen.add(key)
    terms.push(clean)
    tokens += cost
    return true
  }

  for (const term of INSTRUCTION_TERMS) add(term)

  const withCallsign = traffic
    .map((a) => ({ a, m: a.callsign?.match(/^([A-Z]{3})(\d{1,4})$/) }))
    .filter((x): x is { a: Aircraft; m: RegExpMatchArray } => x.m !== null && x.m !== undefined)
    .filter((x) => SPOKEN_BY_ICAO[x.m[1]])
    .sort(
      (x, y) =>
        distanceNm(centre.lat, centre.lon, x.a.lat, x.a.lon) -
        distanceNm(centre.lat, centre.lon, y.a.lat, y.a.lon),
    )

  // Operators present, in nearest-first order so the ones most likely to be
  // addressed get their name in even if the budget runs out.
  for (const { m } of withCallsign) add(SPOKEN_BY_ICAO[m[1]])

  let covered = 0
  let dropped = 0
  for (const { m } of withCallsign) {
    const spoken = SPOKEN_BY_ICAO[m[1]]
    const flight = String(Number(m[2]))
    // The grouped form is what a controller says, so it goes in first. The
    // digit form is a bonus and is allowed to miss out when budget is tight.
    const got = add(`${spoken} ${spokenFlightNumber(flight)}`)
    add(`${spoken} ${flight}`)
    if (got) covered++
    else dropped++
  }

  return { terms, tokens, aircraftCovered: covered, aircraftDropped: dropped }
}
