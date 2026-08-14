// Tests for the conformance engine, with synthetic track buffers.
// Written before lib/conform.ts, per CLAUDE.md phase 4. Covers the cases the
// spec names: correct climb, wrong direction, level off, bust, stale data,
// superseded, plus the heading and speed paths.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TOL,
  evaluate,
  supersede,
  isOpen,
  magneticFromTrue,
  angularDifference,
  normaliseHeading,
} from '../lib/conform.ts'
import type { Clearance, Constraint, TrackSample, Verdict } from '../lib/types.ts'

// A fixed epoch so nothing here depends on the wall clock.
const T0 = 1_700_000_000_000

type SampleSpec = {
  /** Seconds after the clearance was issued. */
  at: number
  alt?: number | null
  vs?: number | null
  gs?: number | null
  trk?: number | null
  nav?: number | null
  seen?: number
}

function samples(specs: SampleSpec[]): TrackSample[] {
  return specs.map((s) => ({
    ts: T0 + s.at * 1000,
    altFt: s.alt ?? null,
    vsFpm: s.vs ?? null,
    gsKt: s.gs ?? null,
    trackTrue: s.trk ?? null,
    navHeading: s.nav ?? null,
    seenPosSec: s.seen ?? 1,
  }))
}

function clearance(constraint: Constraint, overrides: Partial<Clearance> = {}): Clearance {
  return {
    id: 'c1',
    hex: 'a1b2c3',
    spokenText: 'united 328 climb and maintain one zero thousand',
    spokenCallsign: 'united 328',
    resolvedCallsign: 'UAL328',
    registration: 'N27239',
    constraint,
    issuedAt: T0,
    status: 'PENDING',
    detail: '',
    history: [],
    ...overrides,
  }
}

/** Evaluate at `atSec` after issue. */
function verdictAt(c: Clearance, buf: TrackSample[], atSec: number) {
  return evaluate(c, buf, T0 + atSec * 1000)
}

function assertVerdict(a: { verdict: Verdict; detail: string }, expected: Verdict) {
  assert.equal(a.verdict, expected, `expected ${expected}, got ${a.verdict}: ${a.detail}`)
  assert.ok(a.detail.length > 0, 'every verdict must carry a detail line')
}

const CLIMB_10K: Constraint = { kind: 'ALTITUDE', targetFt: 10000, direction: 'up' }
const DESCEND_5K: Constraint = { kind: 'ALTITUDE', targetFt: 5000, direction: 'down' }
const MAINTAIN_7K: Constraint = { kind: 'ALTITUDE', targetFt: 7000, direction: 'hold' }

describe('purity', () => {
  // conform.ts is the file someone will actually read, and the whole reason it
  // is testable is that it has no I/O and no hidden clock.
  const src = readFileSync(new URL('../lib/conform.ts', import.meta.url), 'utf8')

  test('does not read the clock', () => {
    assert.equal(/Date\.now|new Date\(\)/.test(src), false)
  })
  test('does not fetch', () => {
    assert.equal(/\bfetch\(/.test(src), false)
  })
  test('does not import React', () => {
    assert.equal(/from 'react'/.test(src), false)
  })
})

describe('helpers', () => {
  test('magnetic = true - 13 at SFO', () => {
    assert.equal(magneticFromTrue(180), 167)
  })
  test('magnetic conversion wraps below zero', () => {
    // 005 true is 352 magnetic, not -8.
    assert.equal(magneticFromTrue(5), 352)
  })
  test('north is 360, never 0', () => {
    assert.equal(normaliseHeading(0), 360)
    assert.equal(normaliseHeading(720), 360)
  })
  test('angular difference takes the short way round', () => {
    assert.equal(angularDifference(350, 10), 20)
    assert.equal(angularDifference(10, 350), -20)
    assert.equal(angularDifference(90, 270), 180)
  })
})

describe('altitude: the cases from phase 4', () => {
  test('correct climb, still going -> COMPLYING', () => {
    const buf = samples([
      { at: 0, alt: 6000, vs: 0 },
      { at: 10, alt: 6500, vs: 1800 },
      { at: 25, alt: 7200, vs: 1900 },
    ])
    const a = verdictAt(clearance(CLIMB_10K), buf, 25)
    assertVerdict(a, 'COMPLYING')
    // The detail must name the evidence, not just restate the verdict.
    assert.match(a.detail, /7,200|climbing|1,900/)
  })

  test('wrong direction -> DEVIATED', () => {
    const buf = samples([
      { at: 0, alt: 9000, vs: 0 },
      { at: 10, alt: 9400, vs: 2100 },
    ])
    const a = verdictAt(clearance(DESCEND_5K), buf, 10)
    assertVerdict(a, 'DEVIATED')
    assert.match(a.detail, /climb/i)
  })

  test('levelled off at the assigned altitude -> COMPLIED', () => {
    const buf = samples([
      { at: 0, alt: 6000, vs: 1800 },
      { at: 60, alt: 9900, vs: 1200 },
      { at: 90, alt: 10000, vs: 0 },
    ])
    assertVerdict(verdictAt(clearance(CLIMB_10K), buf, 90), 'COMPLIED')
  })

  test('inside the level band counts as level off', () => {
    // 150 ft high is inside the 200 ft band.
    const buf = samples([{ at: 0, alt: 6000, vs: 1800 }, { at: 90, alt: 10150, vs: 100 }])
    assertVerdict(verdictAt(clearance(CLIMB_10K), buf, 90), 'COMPLIED')
  })

  test('busted through the assigned altitude -> DEVIATED', () => {
    const buf = samples([
      { at: 0, alt: 6000, vs: 1800 },
      { at: 90, alt: 10500, vs: 900 },
    ])
    const a = verdictAt(clearance(CLIMB_10K), buf, 90)
    assertVerdict(a, 'DEVIATED')
    assert.match(a.detail, /through|past|bust/i)
  })

  test('no vertical response by the end of the window -> DEVIATED', () => {
    const buf = samples([
      { at: 0, alt: 9000, vs: 0 },
      { at: 21, alt: 9000, vs: 0 },
    ])
    const a = verdictAt(clearance(DESCEND_5K), buf, 21)
    assertVerdict(a, 'DEVIATED')
    assert.match(a.detail, /no vertical response|no response/i)
  })

  test('inside the response window with no movement yet -> PENDING', () => {
    const buf = samples([
      { at: 0, alt: 9000, vs: 0 },
      { at: 8, alt: 9000, vs: 0 },
    ])
    const a = verdictAt(clearance(DESCEND_5K), buf, 8)
    assertVerdict(a, 'PENDING')
    // The countdown is what makes the 20 s window visible rather than implied.
    assert.match(a.detail, /1[12] s|remaining/i)
  })

  test('a rate below the responding threshold does not count as a response', () => {
    const buf = samples([
      { at: 0, alt: 9000, vs: 0 },
      { at: 21, alt: 8950, vs: -150 },
    ])
    assertVerdict(verdictAt(clearance(DESCEND_5K), buf, 21), 'DEVIATED')
  })

  test('already established when the clearance is issued -> COMPLIED', () => {
    const buf = samples([{ at: 0, alt: 10000, vs: 0 }])
    assertVerdict(verdictAt(clearance(CLIMB_10K), buf, 2), 'COMPLIED')
  })

  test('maintain: holding the assigned altitude -> COMPLIED', () => {
    const buf = samples([{ at: 0, alt: 7000, vs: 0 }, { at: 30, alt: 7050, vs: 100 }])
    assertVerdict(verdictAt(clearance(MAINTAIN_7K), buf, 30), 'COMPLIED')
  })

  test('maintain: leaving the assigned altitude -> DEVIATED', () => {
    const buf = samples([{ at: 0, alt: 7000, vs: 0 }, { at: 40, alt: 7600, vs: 1200 }])
    const a = verdictAt(clearance(MAINTAIN_7K), buf, 40)
    assertVerdict(a, 'DEVIATED')
    assert.match(a.detail, /7,600|left|assigned/i)
  })

  test('a long climb still trending is not failed by the eval window', () => {
    // 5,000 to 25,000 ft takes far longer than evalWindowSec. An aircraft still
    // climbing at 2,000 fpm is complying, however long it has been.
    const c = clearance({ kind: 'ALTITUDE', targetFt: 25000, direction: 'up' })
    const buf = samples([
      { at: 0, alt: 5000, vs: 0 },
      { at: 200, alt: 12000, vs: 2000 },
    ])
    assertVerdict(verdictAt(c, buf, 200), 'COMPLYING')
  })

  test('stopped short of the assigned altitude past the eval window -> DEVIATED', () => {
    const buf = samples([
      { at: 0, alt: 6000, vs: 1800 },
      { at: 130, alt: 8000, vs: 0 },
    ])
    const a = verdictAt(clearance(CLIMB_10K), buf, 130)
    assertVerdict(a, 'DEVIATED')
    assert.match(a.detail, /8,000|level|short/i)
  })
})

describe('stale and missing data never produce a deviation', () => {
  test('empty buffer -> UNKNOWN', () => {
    assertVerdict(verdictAt(clearance(CLIMB_10K), [], 10), 'UNKNOWN')
  })

  test('seen_pos beyond the stale threshold -> UNKNOWN', () => {
    const buf = samples([{ at: 0, alt: 9000, vs: 0, seen: 2 }, { at: 30, alt: 9000, vs: 0, seen: 23 }])
    const a = verdictAt(clearance(DESCEND_5K), buf, 30)
    assertVerdict(a, 'UNKNOWN')
    assert.match(a.detail, /stale|23/)
  })

  test('a stale track that looks like a deviation is still UNKNOWN', () => {
    // Climbing hard on a descent clearance, but the position is 40 s old, so
    // there is nothing to report. Never call this a deviation.
    const buf = samples([{ at: 0, alt: 9000, vs: 2500, seen: 40 }])
    assertVerdict(verdictAt(clearance(DESCEND_5K), buf, 5), 'UNKNOWN')
  })

  test('no altitude in the latest sample -> UNKNOWN', () => {
    const buf = samples([{ at: 0, alt: null, vs: null }])
    assertVerdict(verdictAt(clearance(CLIMB_10K), buf, 5), 'UNKNOWN')
  })

  test('a sample older than the stale threshold -> UNKNOWN', () => {
    // seen_pos looks fine, but we have not received anything for 30 s.
    const buf = samples([{ at: 0, alt: 9000, vs: 0, seen: 1 }])
    assertVerdict(verdictAt(clearance(DESCEND_5K), buf, 30), 'UNKNOWN')
  })
})

describe('heading', () => {
  const LEFT_270: Constraint = { kind: 'HEADING', targetDegMag: 270, turn: 'left' }
  const RIGHT_090: Constraint = { kind: 'HEADING', targetDegMag: 90, turn: 'right' }

  test('turning the commanded way -> COMPLYING', () => {
    // nav_heading is already magnetic, so no correction is applied.
    const buf = samples([
      { at: 0, nav: 360, trk: 13 },
      { at: 15, nav: 330, trk: 343 },
    ])
    const a = verdictAt(clearance(LEFT_270), buf, 15)
    assertVerdict(a, 'COMPLYING')
    assert.match(a.detail, /left|330/)
  })

  test('turning the wrong way -> DEVIATED', () => {
    const buf = samples([
      { at: 0, nav: 360, trk: 13 },
      { at: 15, nav: 30, trk: 43 },
    ])
    const a = verdictAt(clearance(LEFT_270), buf, 15)
    assertVerdict(a, 'DEVIATED')
    assert.match(a.detail, /right|wrong/i)
  })

  test('established inside the tolerance -> COMPLIED', () => {
    const buf = samples([{ at: 0, nav: 360 }, { at: 60, nav: 273 }])
    assertVerdict(verdictAt(clearance(LEFT_270), buf, 60), 'COMPLIED')
  })

  test('falls back to track with magnetic variation applied', () => {
    // 283 true is 270 magnetic at 13 east, so this is established.
    const buf = samples([{ at: 0, trk: 13 }, { at: 60, trk: 283 }])
    const a = verdictAt(clearance(LEFT_270), buf, 60)
    assertVerdict(a, 'COMPLIED')
    // The caveat has to be visible: ground track is not heading.
    assert.match(a.detail, /track/i)
  })

  test('says which source it used', () => {
    const withNav = verdictAt(clearance(LEFT_270), samples([{ at: 0, nav: 271 }]), 2)
    assert.match(withNav.detail, /selected heading|nav/i)
  })

  test('fly heading accepts a turn in either direction', () => {
    const shortest: Constraint = { kind: 'HEADING', targetDegMag: 90, turn: 'shortest' }
    const buf = samples([{ at: 0, nav: 360 }, { at: 15, nav: 30 }])
    assertVerdict(verdictAt(clearance(shortest), buf, 15), 'COMPLYING')
  })

  test('no turn by the end of the response window -> DEVIATED', () => {
    const buf = samples([{ at: 0, nav: 360 }, { at: 21, nav: 360 }])
    assertVerdict(verdictAt(clearance(RIGHT_090), buf, 21), 'DEVIATED')
  })

  test('a turn through north is read correctly, not as a 350 degree turn', () => {
    // 010 to 350 magnetic is a 20 degree LEFT turn, not 340 degrees right.
    const buf = samples([{ at: 0, nav: 10 }, { at: 15, nav: 350 }])
    const c = clearance({ kind: 'HEADING', targetDegMag: 300, turn: 'left' })
    assertVerdict(verdictAt(c, buf, 15), 'COMPLYING')
  })

  test('no heading data at all -> UNKNOWN', () => {
    const buf = samples([{ at: 0, alt: 9000 }])
    assertVerdict(verdictAt(clearance(LEFT_270), buf, 5), 'UNKNOWN')
  })
})

describe('speed', () => {
  const SLOW_210: Constraint = { kind: 'SPEED', targetKt: 210 }

  test('decelerating toward the assigned speed -> COMPLYING', () => {
    const buf = samples([{ at: 0, gs: 280 }, { at: 15, gs: 255 }])
    const a = verdictAt(clearance(SLOW_210), buf, 15)
    assertVerdict(a, 'COMPLYING')
    // Ground speed is not indicated airspeed, and the detail has to say so.
    assert.match(a.detail, /ground speed|wind/i)
  })

  test('accelerating away from the assigned speed -> DEVIATED', () => {
    const buf = samples([{ at: 0, gs: 280 }, { at: 15, gs: 310 }])
    assertVerdict(verdictAt(clearance(SLOW_210), buf, 15), 'DEVIATED')
  })

  test('within tolerance -> COMPLIED', () => {
    const buf = samples([{ at: 0, gs: 280 }, { at: 60, gs: 218 }])
    assertVerdict(verdictAt(clearance(SLOW_210), buf, 60), 'COMPLIED')
  })

  test('no speed change by the end of the window -> DEVIATED', () => {
    const buf = samples([{ at: 0, gs: 280 }, { at: 21, gs: 279 }])
    assertVerdict(verdictAt(clearance(SLOW_210), buf, 21), 'DEVIATED')
  })

  test('no ground speed -> UNKNOWN', () => {
    assertVerdict(verdictAt(clearance(SLOW_210), samples([{ at: 0 }]), 5), 'UNKNOWN')
  })
})

describe('superseded', () => {
  const older = clearance(CLIMB_10K, { id: 'old', status: 'COMPLYING' })

  test('a new clearance of the same kind for the same aircraft supersedes the old one', () => {
    const incoming = clearance(DESCEND_5K, { id: 'new', issuedAt: T0 + 30_000 })
    const out = supersede([older], incoming)
    const closed = out.find((c) => c.id === 'old')
    assert.equal(closed?.status, 'SUPERSEDED')
    assert.match(closed?.detail ?? '', /superseded|amend/i)
  })

  test('the superseded clearance is not failed', () => {
    // This is the detail that separates a working engine from one that emits
    // constant false positives on every amended clearance.
    const out = supersede([older], clearance(DESCEND_5K, { id: 'new', issuedAt: T0 + 30_000 }))
    assert.notEqual(out.find((c) => c.id === 'old')?.status, 'DEVIATED')
  })

  test('a different constraint kind does not supersede', () => {
    const incoming = clearance({ kind: 'SPEED', targetKt: 210 }, { id: 'new' })
    const out = supersede([older], incoming)
    assert.equal(out.find((c) => c.id === 'old')?.status, 'COMPLYING')
  })

  test('a different aircraft does not supersede', () => {
    const incoming = clearance(DESCEND_5K, { id: 'new', hex: 'ffffff' })
    const out = supersede([older], incoming)
    assert.equal(out.find((c) => c.id === 'old')?.status, 'COMPLYING')
  })

  test('a closed clearance is left alone', () => {
    const done = clearance(CLIMB_10K, { id: 'done', status: 'DEVIATED', detail: 'busted through' })
    const out = supersede([done], clearance(DESCEND_5K, { id: 'new' }))
    assert.equal(out.find((c) => c.id === 'done')?.status, 'DEVIATED')
    assert.equal(out.find((c) => c.id === 'done')?.detail, 'busted through')
  })

  test('an established clearance IS superseded by a new assignment', () => {
    // An aircraft level at 10,000 that is then told to descend is no longer
    // being held to 10,000, so the old clearance has to stop applying.
    const done = clearance(CLIMB_10K, { id: 'done', status: 'COMPLIED' })
    const out = supersede([done], clearance(DESCEND_5K, { id: 'new' }))
    assert.equal(out.find((c) => c.id === 'done')?.status, 'SUPERSEDED')
  })

  test('an UNKNOWN clearance is still open and can be superseded', () => {
    const lost = clearance(CLIMB_10K, { id: 'lost', status: 'UNKNOWN' })
    const out = supersede([lost], clearance(DESCEND_5K, { id: 'new' }))
    assert.equal(out.find((c) => c.id === 'lost')?.status, 'SUPERSEDED')
  })

  test('the incoming clearance is not in the returned list', () => {
    // supersede only closes the old ones; adding the new clearance is the
    // caller's job, so it cannot be added twice.
    const out = supersede([older], clearance(DESCEND_5K, { id: 'new' }))
    assert.equal(out.some((c) => c.id === 'new'), false)
  })

  test('isOpen', () => {
    assert.equal(isOpen('PENDING'), true)
    assert.equal(isOpen('COMPLYING'), true)
    assert.equal(isOpen('UNKNOWN'), true)
    // Still monitored: "climb and maintain" says maintain, so reaching the
    // altitude is not the end of the clearance.
    assert.equal(isOpen('COMPLIED'), true)
    // Terminal: a deviation is an event that happened at a time.
    assert.equal(isOpen('DEVIATED'), false)
    assert.equal(isOpen('SUPERSEDED'), false)
  })
})

describe('an established clearance keeps being monitored', () => {
  test('still level at the assigned altitude -> COMPLIED', () => {
    const c = clearance(CLIMB_10K, { status: 'COMPLIED' })
    const buf = samples([{ at: 0, alt: 10000, vs: 0 }, { at: 300, alt: 10050, vs: 0 }])
    assertVerdict(verdictAt(c, buf, 300), 'COMPLIED')
  })

  test('level bust long after the clearance -> DEVIATED', () => {
    // The single event most worth catching. If reaching the altitude closed the
    // clearance, this would be invisible.
    const c = clearance(CLIMB_10K, { status: 'COMPLIED' })
    const buf = samples([{ at: 0, alt: 10000, vs: 0 }, { at: 300, alt: 10600, vs: 900 }])
    const a = verdictAt(c, buf, 300)
    assertVerdict(a, 'DEVIATED')
    assert.match(a.detail, /left it|10,600/)
  })

  test('an established heading that drifts off -> DEVIATED', () => {
    const c = clearance({ kind: 'HEADING', targetDegMag: 270, turn: 'left' }, { status: 'COMPLIED' })
    const buf = samples([{ at: 0, nav: 270 }, { at: 300, nav: 300 }])
    const a = verdictAt(c, buf, 300)
    assertVerdict(a, 'DEVIATED')
    assert.match(a.detail, /drift/i)
  })

  test('a small heading wander is not yet a deviation', () => {
    // Wider band to leave than to arrive, so a heading held on the edge of
    // tolerance does not flicker between two verdicts every few seconds.
    const c = clearance({ kind: 'HEADING', targetDegMag: 270, turn: 'left' }, { status: 'COMPLIED' })
    const buf = samples([{ at: 0, nav: 270 }, { at: 300, nav: 285 }])
    assertVerdict(verdictAt(c, buf, 300), 'COMPLYING')
  })

  test('an established speed that drifts off -> DEVIATED', () => {
    const c = clearance({ kind: 'SPEED', targetKt: 210 }, { status: 'COMPLIED' })
    const buf = samples([{ at: 0, gs: 210 }, { at: 300, gs: 260 }])
    assertVerdict(verdictAt(c, buf, 300), 'DEVIATED')
  })

  test('the response window does not re-apply once established', () => {
    // 300 s after issue, far past both windows, and holding the altitude. This
    // must not read as "no vertical response within 20 s".
    const c = clearance(CLIMB_10K, { status: 'COMPLIED' })
    const buf = samples([{ at: 300, alt: 10000, vs: 0 }])
    const a = verdictAt(c, buf, 300)
    assertVerdict(a, 'COMPLIED')
    assert.doesNotMatch(a.detail, /no vertical response/)
  })
})

describe('a superseded clearance is never re-evaluated into something else', () => {
  test('evaluate leaves a closed verdict alone', () => {
    const c = clearance(CLIMB_10K, { status: 'SUPERSEDED', detail: 'superseded by a later clearance' })
    const buf = samples([{ at: 0, alt: 3000, vs: -2000 }])
    const a = verdictAt(c, buf, 30)
    assertVerdict(a, 'SUPERSEDED')
  })
})

describe('tolerances are exported and match the spec', () => {
  test('section 4.6 values', () => {
    assert.equal(TOL.responseWindowSec, 20)
    assert.equal(TOL.evalWindowSec, 120)
    assert.equal(TOL.altLevelBandFt, 200)
    assert.equal(TOL.altBustFt, 400)
    assert.equal(TOL.vsRespondingFpm, 300)
    assert.equal(TOL.vsLevelFpm, 300)
    assert.equal(TOL.hdgToleranceDeg, 10)
    assert.equal(TOL.spdToleranceKt, 15)
    assert.equal(TOL.magVarDeg, 13)
    assert.equal(TOL.staleTrackSec, 15)
  })
})
