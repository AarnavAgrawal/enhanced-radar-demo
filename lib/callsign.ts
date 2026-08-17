// Free text -> spoken callsign -> ICAO callsign -> a live aircraft.
// Pure functions; the live traffic list is passed in.

import type { Aircraft, Resolution } from './types.ts'
import { TELEPHONY, TELEPHONY_KEYS_BY_LENGTH } from './telephony.ts'
// The instruction keyword list lives in parser.ts, which owns the clearance
// grammar. Importing it keeps callsign extraction and clearance parsing from
// ever disagreeing about where the callsign ends.
import { findInstructionStart } from './parser.ts'

/**
 * Spoken digits, including the ICAO variants. Controllers say "niner" so it
 * does not sound like "nine" over a noisy VHF channel, "tree" because the "th"
 * fricative does not survive radio compression, and "fife" so it is not heard
 * as "fire".
 */
export const DIGIT_WORDS: Record<string, string> = {
  zero: '0', o: '0', oh: '0',
  one: '1', wun: '1',
  two: '2', too: '2',
  three: '3', tree: '3',
  four: '4', fower: '4',
  five: '5', fife: '5',
  six: '6',
  seven: '7',
  eight: '8', ait: '8',
  nine: '9', niner: '9',
}

/** Teens spoken as a single word, e.g. "United fifteen" -> UAL15. */
const TEEN_WORDS: Record<string, string> = {
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
}

/** Tens, which may be followed by a unit: "twenty eight" -> 28. */
const TENS_WORDS: Record<string, string> = {
  twenty: '2', thirty: '3', forty: '4', fifty: '5',
  sixty: '6', seventy: '7', eighty: '8', ninety: '9',
}

/**
 * NATO phonetic alphabet, for general aviation registrations read letter by
 * letter: "november one seven two sierra papa" -> N172SP.
 */
export const PHONETIC_LETTERS: Record<string, string> = {
  alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E',
  foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J',
  kilo: 'K', lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P',
  quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V',
  whiskey: 'W', xray: 'X', yankee: 'Y', zulu: 'Z',
}

/** Lowercase, strip punctuation, collapse whitespace. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** The part of the input naming an aircraft: everything before the instruction. */
export function extractSpokenCallsign(text: string): string {
  const tokens = tokenize(text)
  const stop = findInstructionStart(tokens)
  return (stop === -1 ? tokens : tokens.slice(0, stop)).join(' ')
}

/**
 * Turn a spoken flight number into digits.
 *
 * Handles digit-at-a-time ("three two eight"), grouped ("three twenty eight"),
 * teens ("fifteen"), already-typed digits ("328"), and mixtures. Returns null
 * if nothing numeric was found.
 *
 * This deliberately does NOT apply thousand/hundred multipliers. A flight
 * number is a digit string, not a quantity. Altitudes and headings, where the
 * multipliers do matter, belong to parser.ts.
 */
export function spokenNumberToDigits(tokens: string[]): string | null {
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^\d+$/.test(t)) {
      out += t
    } else if (t in DIGIT_WORDS) {
      out += DIGIT_WORDS[t]
    } else if (t in TEEN_WORDS) {
      out += TEEN_WORDS[t]
    } else if (t in TENS_WORDS) {
      const next = tokens[i + 1]
      // "twenty eight" is one number, 28. A bare "twenty" is 20.
      if (next && next in DIGIT_WORDS && DIGIT_WORDS[next] !== '0') {
        out += TENS_WORDS[t] + DIGIT_WORDS[next]
        i++
      } else {
        out += TENS_WORDS[t] + '0'
      }
    } else if (t === 'hundred') {
      // "one hundred" -> "100", padding the number out rather than multiplying.
      out += '00'
    } else {
      return out.length > 0 ? out : null
    }
  }
  return out.length > 0 ? out : null
}

/** What the spoken text names, before we look at live traffic. */
export type CallsignQuery =
  | { kind: 'airline'; icao: string; flightNumber: string; resolvedCallsign: string }
  | { kind: 'registration'; registration: string }
  | { kind: 'unparsed'; reason: string }

/** A registration typed directly: N27239, G-EUUU, F-GZNE, C-FIVR. */
const REGISTRATION_RE = /^(?:N\d{1,5}[a-z]{0,2}|[a-z]{1,2}-[a-z]{3,4})$/i
/** A full ICAO callsign typed directly: UAL328, AFR83K. */
const ICAO_CALLSIGN_RE = /^([a-z]{3})(\d{1,4}[a-z]{0,2})$/i

/**
 * Parse the spoken callsign into an airline plus flight number, or a bare
 * registration. Does not touch live traffic.
 */
export function parseCallsign(text: string): CallsignQuery {
  const spoken = extractSpokenCallsign(text)
  const tokens = tokenize(spoken)
  if (tokens.length === 0) return { kind: 'unparsed', reason: 'no callsign found in input' }

  // Directly typed ICAO callsign, e.g. "UAL328".
  const direct = tokens[0].match(ICAO_CALLSIGN_RE)
  if (tokens.length === 1 && direct) {
    return {
      kind: 'airline',
      icao: direct[1].toUpperCase(),
      flightNumber: direct[2].toUpperCase(),
      resolvedCallsign: tokens[0].toUpperCase(),
    }
  }

  // Directly typed registration, e.g. "N172SP" or "G-EUUU".
  if (tokens.length === 1 && REGISTRATION_RE.test(tokens[0])) {
    return { kind: 'registration', registration: tokens[0].toUpperCase().replace(/-/g, '') }
  }

  // Phonetic registration, e.g. "november one seven two sierra papa". Every
  // token must decode to a letter or digit, and the first must be a letter.
  const phonetic = tokens.map((t) =>
    t in PHONETIC_LETTERS ? PHONETIC_LETTERS[t] : t in DIGIT_WORDS ? DIGIT_WORDS[t] : null,
  )
  if (phonetic.length >= 3 && phonetic.every((c) => c !== null) && tokens[0] in PHONETIC_LETTERS) {
    return { kind: 'registration', registration: phonetic.join('') }
  }

  // Airline name followed by a flight number. Greedy longest-match against the
  // telephony table so "sun country" is not read as "sun" plus a stray word.
  for (const key of TELEPHONY_KEYS_BY_LENGTH) {
    const keyTokens = key.split(' ')
    if (keyTokens.length > tokens.length) continue
    if (!keyTokens.every((k, i) => tokens[i] === k)) continue

    const rest = tokens.slice(keyTokens.length)
    if (rest.length === 0) {
      return { kind: 'unparsed', reason: `"${key}" has no flight number after it` }
    }
    const digits = spokenNumberToDigits(rest)
    if (!digits) {
      return { kind: 'unparsed', reason: `could not read a flight number from "${rest.join(' ')}"` }
    }
    const icao = TELEPHONY[key]
    return { kind: 'airline', icao, flightNumber: digits, resolvedCallsign: icao + digits }
  }

  return { kind: 'unparsed', reason: `"${tokens[0]}" is not a known airline or registration` }
}

/**
 * Compare the flight-number part of two callsigns.
 *
 * Operators are inconsistent about zero padding: the same flight files as
 * UAL328 one day and UAL0328 the next. Compare numerically when both sides are
 * purely numeric, and fall back to an exact compare when a suffix letter is
 * present, as in AFR83K.
 */
function flightNumbersMatch(a: string, b: string): boolean {
  if (a === b) return true
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) === Number(b)
  return false
}

/**
 * Resolve free text against the current traffic picture.
 *
 * Three outcomes, and an ambiguous match is never collapsed into a guess. If
 * two aircraft could be the one addressed, the operator gets both and decides.
 */
export function resolveCallsign(text: string, traffic: Aircraft[]): Resolution {
  const spokenCallsign = extractSpokenCallsign(text)
  const query = parseCallsign(text)

  if (query.kind === 'unparsed') {
    return { outcome: 'none', spokenCallsign, resolvedCallsign: null, reason: query.reason }
  }

  if (query.kind === 'registration') {
    const matches = traffic.filter((a) => a.registration === query.registration)
    if (matches.length === 1) {
      return {
        outcome: 'exact',
        spokenCallsign,
        resolvedCallsign: matches[0].callsign ?? query.registration,
        aircraft: matches[0],
      }
    }
    if (matches.length > 1) {
      return {
        outcome: 'ambiguous',
        spokenCallsign,
        resolvedCallsign: query.registration,
        candidates: matches,
      }
    }
    return {
      outcome: 'none',
      spokenCallsign,
      resolvedCallsign: query.registration,
      reason: `${query.registration} is not in the live traffic picture`,
    }
  }

  const matches = traffic.filter((a) => {
    if (!a.callsign) return false
    const m = a.callsign.match(ICAO_CALLSIGN_RE)
    if (!m) return false
    return (
      m[1].toUpperCase() === query.icao &&
      flightNumbersMatch(m[2].toUpperCase(), query.flightNumber)
    )
  })

  if (matches.length === 1) {
    return {
      outcome: 'exact',
      spokenCallsign,
      resolvedCallsign: matches[0].callsign as string,
      aircraft: matches[0],
    }
  }
  if (matches.length > 1) {
    // Two live aircraft broadcasting the same flight ID. Rare, but it happens
    // around a diversion and re-dispatch, and guessing is worse than asking.
    return {
      outcome: 'ambiguous',
      spokenCallsign,
      resolvedCallsign: query.resolvedCallsign,
      candidates: matches,
    }
  }
  return {
    outcome: 'none',
    spokenCallsign,
    resolvedCallsign: query.resolvedCallsign,
    reason: `${query.resolvedCallsign} is not in the live traffic picture`,
  }
}

/**
 * Aircraft sharing the airline prefix, offered as a "did you mean" when the
 * exact flight number is not airborne. A hint for the operator, not a match.
 */
export function suggestSameAirline(text: string, traffic: Aircraft[], limit = 6): Aircraft[] {
  const query = parseCallsign(text)
  if (query.kind !== 'airline') return []
  return traffic
    .filter((a) => a.callsign?.startsWith(query.icao))
    .sort((a, b) => (a.callsign ?? '').localeCompare(b.callsign ?? ''))
    .slice(0, limit)
}
