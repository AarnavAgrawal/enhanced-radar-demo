// Tests for the clearance parser. Written before lib/parser.ts, per CLAUDE.md
// phase 3. Covers every row of section 4.4 and every form of section 4.5.
//
// Run: npm test

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAviationNumber,
  parseInstruction,
  findInstructionStart,
  describeConstraint,
} from '../lib/parser.ts'
import { tokenize } from '../lib/callsign.ts'
import { formatAltitude, formatFeet, altitudeTag, formatAltitudeShort } from '../lib/format.ts'

/** Convenience: parse and assert it succeeded, returning the constraint. */
function constraintOf(text: string) {
  const r = parseInstruction(text)
  assert.equal(r.ok, true, `expected "${text}" to parse, got: ${r.ok ? '' : r.reason}`)
  if (!r.ok) throw new Error('unreachable')
  return r.constraint
}

function num(text: string): number | null {
  return parseAviationNumber(tokenize(text))
}

describe('4.4 aviation number normalisation', () => {
  // The exact table from CLAUDE.md section 4.4.
  test('one zero thousand -> 10000', () => assert.equal(num('one zero thousand'), 10000))
  test('ten thousand -> 10000', () => assert.equal(num('ten thousand'), 10000))
  test('five thousand five hundred -> 5500', () =>
    assert.equal(num('five thousand five hundred'), 5500))
  test('flight level two five zero -> 25000', () =>
    assert.equal(num('flight level two five zero'), 25000))
  test('two seven zero (heading) -> 270', () => assert.equal(num('two seven zero'), 270))
  test('niner -> 9', () => assert.equal(num('niner'), 9))
  test('tree -> 3', () => assert.equal(num('tree'), 3))
  test('fife -> 5', () => assert.equal(num('fife'), 5))

  // Forms a controller will actually say that are not in the table.
  test('one two thousand -> 12000', () => assert.equal(num('one two thousand'), 12000))
  test('eleven thousand -> 11000', () => assert.equal(num('eleven thousand'), 11000))
  test('seventeen thousand -> 17000', () => assert.equal(num('seventeen thousand'), 17000))
  test('three thousand -> 3000', () => assert.equal(num('three thousand'), 3000))
  test('twenty five hundred -> 2500', () => assert.equal(num('twenty five hundred'), 2500))
  test('one thousand five hundred -> 1500', () =>
    assert.equal(num('one thousand five hundred'), 1500))
  test('zero niner zero keeps its leading zero -> 90', () =>
    assert.equal(num('zero niner zero'), 90))
  test('tree fife zero -> 350', () => assert.equal(num('tree fife zero'), 350))
  test('flight level one eight zero -> 18000', () =>
    assert.equal(num('flight level one eight zero'), 18000))
  test('FL250 -> 25000', () => assert.equal(num('fl250'), 25000))

  // Typed digits, because the text box is the primary input path.
  test('typed 10000 -> 10000', () => assert.equal(num('10000'), 10000))
  test('typed 10,000 -> 10000', () => assert.equal(num('10,000'), 10000))
  test('typed 270 -> 270', () => assert.equal(num('270'), 270))
  test('typed 5500 -> 5500', () => assert.equal(num('5500'), 5500))
  test('mixed "10 thousand" -> 10000', () => assert.equal(num('10 thousand'), 10000))

  test('nothing numeric -> null', () => assert.equal(num('and maintain'), null))
  test('empty -> null', () => assert.equal(num(''), null))
})

describe('4.5 clearance grammar, the nine forms', () => {
  test('1. climb and maintain <alt>', () => {
    assert.deepEqual(constraintOf('united 328 climb and maintain one zero thousand'), {
      kind: 'ALTITUDE',
      targetFt: 10000,
      direction: 'up',
    })
  })

  test('2. descend and maintain <alt>', () => {
    assert.deepEqual(constraintOf('speedbird 287 descend and maintain five thousand'), {
      kind: 'ALTITUDE',
      targetFt: 5000,
      direction: 'down',
    })
  })

  test('3. maintain <alt>', () => {
    assert.deepEqual(constraintOf('skywest 3311 maintain seven thousand'), {
      kind: 'ALTITUDE',
      targetFt: 7000,
      direction: 'hold',
    })
  })

  test('4. turn left heading <hdg>', () => {
    assert.deepEqual(constraintOf('united 328 turn left heading two seven zero'), {
      kind: 'HEADING',
      targetDegMag: 270,
      turn: 'left',
    })
  })

  test('5. turn right heading <hdg>', () => {
    assert.deepEqual(constraintOf('delta 1201 turn right heading zero niner zero'), {
      kind: 'HEADING',
      targetDegMag: 90,
      turn: 'right',
    })
  })

  test('6. fly heading <hdg>', () => {
    assert.deepEqual(constraintOf('alaska 1302 fly heading three one zero'), {
      kind: 'HEADING',
      targetDegMag: 310,
      turn: 'shortest',
    })
  })

  test('7. maintain <spd> knots', () => {
    assert.deepEqual(constraintOf('asiana 212 maintain two five zero knots'), {
      kind: 'SPEED',
      targetKt: 250,
    })
  })

  test('8. reduce speed to <spd>', () => {
    assert.deepEqual(constraintOf('jetblue 915 reduce speed to two one zero'), {
      kind: 'SPEED',
      targetKt: 210,
    })
  })

  test('9. increase speed to <spd>', () => {
    assert.deepEqual(constraintOf('fedex 1234 increase speed to two eight zero'), {
      kind: 'SPEED',
      targetKt: 280,
    })
  })
})

describe('altitude', () => {
  test('flight level form', () => {
    assert.deepEqual(constraintOf('united 328 climb and maintain flight level two five zero'), {
      kind: 'ALTITUDE',
      targetFt: 25000,
      direction: 'up',
    })
  })

  test('"climb maintain" without the "and"', () => {
    assert.equal(constraintOf('united 328 climb maintain 8000').kind, 'ALTITUDE')
  })

  test('"descend to" is accepted', () => {
    assert.deepEqual(constraintOf('united 328 descend to 5000'), {
      kind: 'ALTITUDE',
      targetFt: 5000,
      direction: 'down',
    })
  })

  test('typed digits with a comma', () => {
    assert.equal(constraintOf('united 328 climb and maintain 10,000').kind, 'ALTITUDE')
  })

  test('trailing words after the altitude are ignored', () => {
    assert.deepEqual(constraintOf('united 328 climb and maintain 10000 expedite'), {
      kind: 'ALTITUDE',
      targetFt: 10000,
      direction: 'up',
    })
  })

  test('rejects an altitude above the service ceiling of the airspace', () => {
    const r = parseInstruction('united 328 climb and maintain 99000')
    assert.equal(r.ok, false)
  })

  test('rejects an altitude that is not a multiple of 100', () => {
    const r = parseInstruction('united 328 climb and maintain 5250')
    assert.equal(r.ok, false)
  })

  test('rejects a missing altitude', () => {
    const r = parseInstruction('united 328 climb and maintain')
    assert.equal(r.ok, false)
  })
})

describe('heading', () => {
  test('heading 360 is north, not zero', () => {
    assert.deepEqual(constraintOf('united 328 fly heading 360'), {
      kind: 'HEADING',
      targetDegMag: 360,
      turn: 'shortest',
    })
  })

  test('"turn left" without the word heading', () => {
    assert.deepEqual(constraintOf('united 328 turn left 270'), {
      kind: 'HEADING',
      targetDegMag: 270,
      turn: 'left',
    })
  })

  test('rejects a heading above 360', () => {
    assert.equal(parseInstruction('united 328 fly heading 420').ok, false)
  })

  test('rejects heading zero', () => {
    assert.equal(parseInstruction('united 328 fly heading 000').ok, false)
  })

  test('rejects a missing heading', () => {
    assert.equal(parseInstruction('united 328 turn left heading').ok, false)
  })
})

describe('speed', () => {
  test('"reduce speed" without the "to"', () => {
    assert.deepEqual(constraintOf('united 328 reduce speed 180'), { kind: 'SPEED', targetKt: 180 })
  })

  test('"maintain 250 knots" is a speed, not an altitude', () => {
    assert.deepEqual(constraintOf('united 328 maintain 250 knots'), {
      kind: 'SPEED',
      targetKt: 250,
    })
  })

  test('"maintain 250" without knots is not a valid altitude and is rejected', () => {
    // 250 ft is not a multiple of 100 and is below any assignable altitude.
    // Silently reading it as a speed would be guessing.
    assert.equal(parseInstruction('united 328 maintain 250').ok, false)
  })

  test('rejects an implausible speed', () => {
    assert.equal(parseInstruction('united 328 reduce speed to 900').ok, false)
  })
})

describe('separating the callsign from the instruction', () => {
  test('finds the instruction keyword after a multi word callsign', () => {
    const tokens = tokenize('sun country 415 descend and maintain 6000')
    assert.equal(tokens[findInstructionStart(tokens)], 'descend')
  })

  test('parses when only the instruction is given', () => {
    assert.deepEqual(constraintOf('descend and maintain 5000'), {
      kind: 'ALTITUDE',
      targetFt: 5000,
      direction: 'down',
    })
  })

  test('reports the instruction text it actually parsed', () => {
    const r = parseInstruction('united 328 climb and maintain one zero thousand')
    assert.equal(r.ok, true)
    assert.equal(r.instruction, 'climb and maintain one zero thousand')
  })

  test('a callsign with no instruction is rejected with a reason', () => {
    const r = parseInstruction('united 328')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /no instruction/i)
  })

  test('an unrecognised instruction is rejected with a reason', () => {
    const r = parseInstruction('united 328 cleared for the approach')
    assert.equal(r.ok, false)
  })

  test('case and punctuation do not matter', () => {
    assert.deepEqual(constraintOf('United 328, CLIMB AND MAINTAIN one zero thousand.'), {
      kind: 'ALTITUDE',
      targetFt: 10000,
      direction: 'up',
    })
  })
})

describe('how altitudes are written back out', () => {
  // Below 18,000 ft an aircraft flies an altitude in feet. At and above it,
  // everyone sets 29.92 and flies a flight level. Same measurement, different
  // reference, different notation -- and a pilot reads "35,000 ft" as a tell
  // that whoever wrote it does not work in the system.
  test('a flight level comes back as a flight level', () => {
    const r = parseInstruction('united 328 climb and maintain flight level 350')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.constraint.kind === 'ALTITUDE' && r.constraint.targetFt, 35000)
    assert.equal(describeConstraint(r.constraint), 'climb and maintain FL350')
  })

  test('typed feet above the transition altitude are still a flight level', () => {
    const r = parseInstruction('united 328 climb and maintain 35000')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(describeConstraint(r.constraint), 'climb and maintain FL350')
  })

  test('below the transition altitude stays in feet', () => {
    const r = parseInstruction('united 328 descend and maintain one zero thousand')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(describeConstraint(r.constraint), 'descend and maintain 10,000 ft')
  })

  test('exactly 18,000 ft is FL180', () => {
    const r = parseInstruction('united 328 climb and maintain 18000')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(describeConstraint(r.constraint), 'climb and maintain FL180')
  })

  test('a two digit flight level keeps three digits', () => {
    assert.equal(formatAltitude(24000), 'FL240')
    assert.equal(altitudeTag(8500), '085')
    assert.equal(altitudeTag(35000), '350')
  })

  test('the short form never invents a flight level below the transition altitude', () => {
    // There is no FL096. The lowest usable flight level in the US is FL180.
    assert.equal(formatAltitudeShort(9600), '9,600')
    assert.equal(formatAltitudeShort(17900), '17,900')
    assert.equal(formatAltitudeShort(18000), 'FL180')
    assert.equal(formatAltitudeShort(35000), 'FL350')
  })

  test('phraseology, not paraphrase', () => {
    assert.equal(
      describeConstraint({ kind: 'HEADING', targetDegMag: 90, turn: 'left' }),
      'turn left heading 090',
    )
    assert.equal(describeConstraint({ kind: 'SPEED', targetKt: 250 }), 'maintain 250 knots')
  })

  test('a vertical distance is never a flight level', () => {
    // "3,000 ft to run" is a gap between altitudes. FL030 would be nonsense.
    assert.equal(formatFeet(35000), '35,000 ft')
  })

  test('headings keep their leading zero', () => {
    const r = parseInstruction('united 328 fly heading 090')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.match(describeConstraint(r.constraint), /090/)
  })
})

describe('phase 3 done-when, from CLAUDE.md section 6', () => {
  test('"united 328 climb and maintain one zero thousand"', () => {
    const r = parseInstruction('united 328 climb and maintain one zero thousand')
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.constraint, { kind: 'ALTITUDE', targetFt: 10000, direction: 'up' })
  })
})
