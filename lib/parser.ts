// Clearance grammar and aviation number normalisation.
// See CLAUDE.md sections 4.4 and 4.5. Pure functions, no I/O, no clock.
//
// This is a grammar, not a prompt. ATC phraseology is close to a regular
// language and a grammar can be stepped through at 2am when a verdict looks
// wrong. An LLM call cannot.

import type { Constraint } from './types.ts'
import { DIGIT_WORDS, tokenize } from './callsign.ts'
import { formatAltitude, formatHeading } from './format.ts'

/**
 * The word that opens an instruction. Everything before the first one of these
 * is the callsign. Shared with callsign.ts so the two modules can never
 * disagree about where the callsign ends and the instruction begins.
 */
export const INSTRUCTION_KEYWORDS: ReadonlySet<string> = new Set([
  'climb', 'descend', 'maintain', 'turn', 'fly', 'heading', 'reduce',
  'increase', 'speed', 'cross', 'expect', 'contact', 'cleared', 'hold',
  'proceed', 'direct', 'resume', 'squawk', 'traffic',
])

/** Index of the first instruction word, or -1 if the input is all callsign. */
export function findInstructionStart(tokens: string[]): number {
  return tokens.findIndex((t) => INSTRUCTION_KEYWORDS.has(t))
}

/** Numbers spoken as one word. Controllers do use these for round values. */
const WORD_NUMBERS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
  ninety: 90,
}

/**
 * Normalise a spoken number to its value. See CLAUDE.md section 4.4.
 *
 * Controllers do not speak normal numbers. Altitudes are read digit by digit
 * and then scaled -- "one zero thousand" is ten thousand feet, not one, zero,
 * thousand. The approach is the one the spec prescribes: accumulate digits into
 * a string, then let "thousand" and "hundred" act as multipliers on whatever
 * has accumulated so far.
 *
 * Digits accumulate as a STRING rather than as a running total, because
 * "two five zero" is 250 and not 2 + 5 + 0, and because a leading zero in
 * "zero niner zero" has to survive until the end.
 *
 * Returns null when no number is present.
 */
export function parseAviationNumber(tokens: string[]): number | null {
  let total: number | null = null
  let digits = ''
  /** "flight level two five zero" is 25,000 ft: the value is in hundreds. */
  let flightLevel = false

  const flush = (): number | null => {
    if (digits === '') return null
    const v = Number(digits)
    digits = ''
    return v
  }
  const addToTotal = (v: number) => {
    total = (total ?? 0) + v
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]

    // "flight level" as two words, or "FL250" as one.
    if (t === 'flight' && tokens[i + 1] === 'level') {
      flightLevel = true
      i++
      continue
    }
    const fl = t.match(/^fl(\d{2,3})$/)
    if (fl) {
      flightLevel = true
      digits += fl[1]
      continue
    }

    if (/^\d+$/.test(t)) {
      digits += t
      continue
    }
    if (t in DIGIT_WORDS) {
      digits += DIGIT_WORDS[t]
      continue
    }
    if (t in WORD_NUMBERS) {
      const v = WORD_NUMBERS[t]
      // A tens word followed by a unit is one number, not two: "twenty five
      // hundred" is 2,500 and not 205 hundred. Combine them before appending.
      const next = tokens[i + 1]
      if (v >= 20 && v % 10 === 0 && next && next in DIGIT_WORDS && DIGIT_WORDS[next] !== '0') {
        digits += String(v + Number(DIGIT_WORDS[next]))
        i++
        continue
      }
      digits += String(v)
      continue
    }
    if (t === 'thousand') {
      const v = flush()
      if (v === null) return total
      addToTotal(v * 1000)
      continue
    }
    if (t === 'hundred') {
      const v = flush()
      if (v === null) return total
      addToTotal(v * 100)
      continue
    }
    // Filler that can appear inside a number phrase without changing it.
    if (t === 'and' || t === 'point') continue

    // Anything else ends the number. Trailing words after a complete number
    // are ignored rather than treated as an error, so "climb and maintain
    // 10000 expedite" still parses.
    break
  }

  const tail = flush()
  if (tail !== null) addToTotal(tail)
  if (total === null) return null
  return flightLevel ? total * 100 : total
}

/** Which of the nine grammar forms matched. Useful in the UI and in debugging. */
export type ClearanceForm =
  | 'climb and maintain'
  | 'descend and maintain'
  | 'maintain altitude'
  | 'turn left heading'
  | 'turn right heading'
  | 'fly heading'
  | 'maintain speed'
  | 'reduce speed'
  | 'increase speed'

export type ParsedInstruction =
  | { ok: true; constraint: Constraint; instruction: string; form: ClearanceForm }
  | { ok: false; instruction: string; reason: string }

/**
 * Assignable altitudes. Below 1,000 ft nothing is assigned in this airspace,
 * and above 45,000 ft nothing in the SFO arrival or departure stream is flying.
 * ATC assigns altitudes in hundreds, so a value that is not a multiple of 100
 * means the number was misheard or mistyped.
 */
const ALT_MIN_FT = 1000
const ALT_MAX_FT = 45000

/** Assignable speeds. Below 100 kt is a light aircraft on final, above 350 is unrealistic for a vector. */
const SPD_MIN_KT = 100
const SPD_MAX_KT = 350

function altitudeConstraint(
  ft: number | null,
  direction: 'up' | 'down' | 'hold',
  instruction: string,
): ParsedInstruction {
  if (ft === null) return { ok: false, instruction, reason: 'no altitude in the instruction' }
  if (ft % 100 !== 0) {
    return { ok: false, instruction, reason: `${ft} is not an assignable altitude, ATC assigns in hundreds of feet` }
  }
  if (ft < ALT_MIN_FT || ft > ALT_MAX_FT) {
    return { ok: false, instruction, reason: `${ft.toLocaleString('en-US')} ft is outside the assignable range ${ALT_MIN_FT}-${ALT_MAX_FT} ft` }
  }
  return {
    ok: true,
    instruction,
    form: direction === 'up' ? 'climb and maintain' : direction === 'down' ? 'descend and maintain' : 'maintain altitude',
    constraint: { kind: 'ALTITUDE', targetFt: ft, direction },
  }
}

function headingConstraint(
  deg: number | null,
  turn: 'left' | 'right' | 'shortest',
  instruction: string,
): ParsedInstruction {
  if (deg === null) return { ok: false, instruction, reason: 'no heading in the instruction' }
  // Headings run 001 through 360. North is assigned as "heading three six zero",
  // never as zero, so a zero here means the number was misread.
  if (deg < 1 || deg > 360) {
    return { ok: false, instruction, reason: `${deg} is not a valid heading, headings run 001 to 360` }
  }
  return {
    ok: true,
    instruction,
    form: turn === 'left' ? 'turn left heading' : turn === 'right' ? 'turn right heading' : 'fly heading',
    constraint: { kind: 'HEADING', targetDegMag: deg, turn },
  }
}

function speedConstraint(kt: number | null, form: ClearanceForm, instruction: string): ParsedInstruction {
  if (kt === null) return { ok: false, instruction, reason: 'no speed in the instruction' }
  if (kt < SPD_MIN_KT || kt > SPD_MAX_KT) {
    return { ok: false, instruction, reason: `${kt} kt is outside the assignable range ${SPD_MIN_KT}-${SPD_MAX_KT} kt` }
  }
  return { ok: true, instruction, form, constraint: { kind: 'SPEED', targetKt: kt } }
}

/**
 * Parse a clearance into a constraint.
 *
 * Accepts the full spoken text including the callsign, and parses from the
 * first instruction keyword onward. The nine forms of section 4.5 are the
 * grammar; a few optional words ("and", "to") are tolerated because people drop
 * them, but nothing outside the nine forms is guessed at.
 */
export function parseInstruction(text: string): ParsedInstruction {
  const allTokens = tokenize(text.replace(/(\d),(\d)/g, '$1$2'))
  const start = findInstructionStart(allTokens)
  if (start === -1) {
    return { ok: false, instruction: '', reason: 'no instruction found, only a callsign' }
  }

  const tokens = allTokens.slice(start)
  const instruction = tokens.join(' ')
  /** Skip the filler words operators drop or add freely. */
  const rest = (from: number) => {
    let i = from
    while (i < tokens.length && (tokens[i] === 'and' || tokens[i] === 'to' || tokens[i] === 'maintain')) i++
    return tokens.slice(i)
  }

  const head = tokens[0]

  // Forms 1 and 2: climb / descend and maintain <alt>.
  if (head === 'climb' || head === 'descend') {
    const direction = head === 'climb' ? 'up' : 'down'
    return altitudeConstraint(parseAviationNumber(rest(1)), direction, instruction)
  }

  // Forms 4 and 5: turn left / right heading <hdg>.
  if (head === 'turn') {
    const dir = tokens[1]
    if (dir !== 'left' && dir !== 'right') {
      return { ok: false, instruction, reason: '"turn" must be followed by left or right' }
    }
    // "heading" is optional: "turn left 270" is understood.
    const from = tokens[2] === 'heading' ? 3 : 2
    return headingConstraint(parseAviationNumber(tokens.slice(from)), dir, instruction)
  }

  // Form 6: fly heading <hdg>.
  if (head === 'fly') {
    const from = tokens[1] === 'heading' ? 2 : 1
    return headingConstraint(parseAviationNumber(tokens.slice(from)), 'shortest', instruction)
  }

  // A bare "heading 270" with no verb in front of it.
  if (head === 'heading') {
    return headingConstraint(parseAviationNumber(tokens.slice(1)), 'shortest', instruction)
  }

  // Forms 8 and 9: reduce / increase speed to <spd>.
  if (head === 'reduce' || head === 'increase') {
    let i = 1
    if (tokens[i] === 'speed') i++
    if (tokens[i] === 'to') i++
    return speedConstraint(
      parseAviationNumber(tokens.slice(i)),
      head === 'reduce' ? 'reduce speed' : 'increase speed',
      instruction,
    )
  }

  // Forms 3 and 7 share a verb. "maintain <n> knots" is a speed; "maintain
  // <n>" is an altitude. The trailing unit is the only thing separating them,
  // so it decides, and a bare number that is not a valid altitude is rejected
  // rather than guessed at.
  if (head === 'maintain') {
    const body = rest(1)
    const isSpeed = body.includes('knots') || body.includes('knot')
    if (isSpeed) {
      return speedConstraint(parseAviationNumber(body), 'maintain speed', instruction)
    }
    return altitudeConstraint(parseAviationNumber(body), 'hold', instruction)
  }

  // "speed 250" with no verb.
  if (head === 'speed') {
    return speedConstraint(parseAviationNumber(rest(1)), 'maintain speed', instruction)
  }

  return {
    ok: false,
    instruction,
    reason: `"${instruction}" is not one of the nine clearance forms this parser understands`,
  }
}

/**
 * One line of plain English for a constraint, for the UI and later for the
 * verdict detail line. Headings are rendered three digits with a leading zero
 * the way they are written on a strip: 090, not 90.
 */
export function describeConstraint(c: Constraint): string {
  switch (c.kind) {
    case 'ALTITUDE': {
      // FL350 above the transition altitude, 10,000 ft below it.
      const a = formatAltitude(c.targetFt)
      if (c.direction === 'up') return `climb to ${a}`
      if (c.direction === 'down') return `descend to ${a}`
      return `maintain ${a}`
    }
    case 'HEADING': {
      const h = formatHeading(c.targetDegMag)
      if (c.turn === 'left') return `turn left to heading ${h}° magnetic`
      if (c.turn === 'right') return `turn right to heading ${h}° magnetic`
      return `fly heading ${h}° magnetic`
    }
    case 'SPEED':
      return `maintain ${c.targetKt} kt`
  }
}
