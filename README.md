# Clearance Conformance Monitor

A live clearance conformance monitor for traffic within 40 nm of SFO.

You type an air traffic control clearance at an aircraft that is airborne right
now. The app resolves which aircraft was addressed, binds it to its live ADS-B
track, and reports whether it is doing what it was told.

> **The aircraft never heard the clearance.** The clearance is synthetic and is
> never transmitted. The aircraft, the ADS-B tracks and the conformance logic are
> real. This is a test harness that lets a human drive the conformance engine
> directly, standing in for a speech recognition pipeline that is out of scope.

## Status

| Phase | | |
|---|---|---|
| 1 | Live traffic proxy and table | **done** |
| 2 | Callsign resolution | **done** |
| 3 | Clearance parser | **done** |
| 4 | Conformance engine | **done** |
| 5 | The board | **done** |
| 6 | Expo hardening (replay mode) | not started |
| 7 | Voice (Deepgram) | not started |

## Running it

Windows, PowerShell:

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Then open http://localhost:3000. No API key is needed for phases 1 to 3 —
adsb.lol is free and unauthenticated.

Tests:

```powershell
npm test
```

The tests run on Node's built-in runner (`node --test`) using native TypeScript
type stripping, so there is no test framework dependency. That is why the
modules inside `lib/` import each other with explicit `.ts` extensions: Node
resolves ES modules strictly and will not guess the extension for you.

## Environment

`.env.local` is gitignored. `.env.example` is the template.

| Variable | Needed for | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | Phase 7 voice only | Server side only. Do **not** prefix `NEXT_PUBLIC_`, that would ship the key to the browser. |
| `AIRPLANES_LIVE_ENABLED` | Optional ADS-B fallback | Leave `0`. airplanes.live now requires per-project approval and returns HTTP 403 to unregistered callers. |

To set the Deepgram key in PowerShell without opening an editor:

```powershell
Add-Content .env.local 'DEEPGRAM_API_KEY=your_key_here' -Encoding utf8
```

## What works today

**Live traffic.** `/api/traffic` proxies adsb.lol server side, so the browser
never hits the upstream and there is no CORS problem. The page polls it every
2 seconds. One server-side cache serves every connected client and holds the
last good picture, so a failed poll shows a stale badge rather than a blank
board. Roughly 100 to 120 aircraft are usually in the ring.

**Callsign resolution.** Free text resolves to a live aircraft:

```
united 969              -> UAL969  hex a2cb32  N27964  B789
united niner six niner  -> UAL969  hex a2cb32  N27964  B789
UAL969                  -> UAL969  hex a2cb32  N27964  B789
N27964                  -> UAL969  hex a2cb32  N27964  B789
```

Accepted forms: telephony name plus flight number (`brickyard 4412`), marketing
name plus flight number (`republic 4412`), digit-at-a-time (`asiana two one
two`), grouped (`united three twenty eight`), ICAO variants (`niner`, `tree`,
`fife`), a typed ICAO callsign, a typed registration, and a phonetic
registration (`november one seven two sierra papa`).

Three outcomes, and **an ambiguous match is never collapsed into a guess**:

- `exact` — one live aircraft matches.
- `ambiguous` — more than one matches; all candidates are shown and the operator
  picks.
- `none` — nothing matches, with the reason, plus a "same operator airborne now"
  hint when the airline was understood but that flight number is not up.

Zero padding is tolerated, because the same flight files as `UAL328` one day and
`UAL0328` the next.

**Clearance parsing.** A grammar, not a prompt. A grammar can be stepped
through at 2am when a verdict looks wrong.

```
united 328 climb and maintain one zero thousand
   -> { kind: 'ALTITUDE', targetFt: 10000, direction: 'up' }
alaska 1340 turn left heading two seven zero
   -> { kind: 'HEADING', targetDegMag: 270, turn: 'left' }
jetblue 416 reduce speed to two one zero
   -> { kind: 'SPEED', targetKt: 210 }
```

All nine forms from the phraseology table are covered, plus `flight level two
five zero`, `FL250`, typed digits, and the optional words people drop (`climb
maintain 8000`, `reduce speed 180`, `turn left 270`).

Numbers are normalised the way they are spoken, not the way they are written:
`one zero thousand` and `ten thousand` are both 10,000; `five thousand five
hundred` is 5,500; `twenty five hundred` is 2,500; `zero niner zero` keeps its
leading zero and is 90. `niner`, `tree` and `fife` are understood.

Implausible values are rejected with a reason rather than guessed at — an
altitude that is not a multiple of 100, a heading above 360, a speed of 900 kt,
and `maintain 250` with no unit, which could be either an altitude or a speed.

**Conformance verdicts.** `evaluate(clearance, trackBuffer, now)` returns a
verdict and a detail line that names the evidence:

```
COMPLYING   climbing at 3,136 fpm through 16,925 ft, 3,075 ft to run to the
            assigned 20,000 ft
PENDING     assigned a right turn to 090 deg, no turn yet from 073 deg, 8 s of
            the 20 s window remaining
DEVIATED    assigned descent to 12,000 ft, aircraft is climbing at 3,008 fpm
            at 17,550 ft
SUPERSEDED  superseded by a later altitude clearance for FDX5043
```

There is never a bare verdict. `DEVIATED` on its own is an accusation; with the
altitudes and the rate attached it is an observation someone can check.

Amendments close the old clearance as `SUPERSEDED` rather than letting it fail
the response window it can no longer meet. Without that, the board fills with
false deviations the moment anyone amends anything, which is most of what real
ATC does.

Stale or missing data returns `UNKNOWN`, never `DEVIATED`. An aircraft whose
position is 40 s old is not deviating, it is unobserved.

Headings are compared in degrees magnetic. `nav_heading` is used when the
autopilot broadcasts it; otherwise ground track is corrected by 13 degrees for
variation and the detail line says so, because track is not heading in a
crosswind.

**The board.** One row per clearance issued this session, closed ones included,
because a monitor whose history scrolls away is not much use to the person
reviewing it. Each row carries the spoken callsign, the resolved callsign, the
tail, the current altitude and vertical rate, the clearance in plain English, a
trend line with the assigned value drawn across it as a dashed reference, the
verdict badge, and the evidence line underneath. PENDING rows show the response
window counting down.

An `ambiguous` resolution is offered as buttons; clicking one issues the
clearance against that aircraft. The app never picks for you.

Reaching the assigned value does not close a clearance. "Climb and maintain one
zero thousand" says *maintain*, so an aircraft that levels at 10,000 and later
drifts off it turns from COMPLIED to DEVIATED. Leaving a value takes a wider
band than arriving at it did, so a heading held on the edge of tolerance does
not flicker between verdicts. DEVIATED is terminal: it records something that
happened at a time.

## Layout

```
app/api/traffic/route.ts   proxy to adsb.lol, last-known-good cache
app/page.tsx               the board
app/components/            ClearanceBoard, Sparkline
lib/adsb.ts                fetch + normalise raw ADS-B into Aircraft
lib/telephony.ts           spoken airline name -> ICAO prefix
lib/callsign.ts            free text -> ICAO callsign -> live aircraft
lib/parser.ts              clearance grammar + aviation number normalisation
lib/conform.ts             the verdict engine, pure functions only
lib/board.ts               session state, pure reducer
lib/types.ts               shared data model
tests/parser.test.ts       58 tests, every row of 4.4 and every form of 4.5
tests/conform.test.ts      49 tests against synthetic track buffers
```

`lib/parser.ts` and `lib/conform.ts` are pure: no fetch, no clock read, no
React. `evaluate(clearance, buffer, now)` takes the time as an argument, which
is what makes every verdict reproducible and what will let replay mode drive a
synthetic clock. Three of the tests assert that purity by reading the source.

`hex`, the ICAO 24 bit address, is the primary key everywhere. It is burned into
the transponder. Callsigns are reused by a different airframe tomorrow.

## Known limitations

State these out loud rather than hoping nobody notices.

- **The aircraft never received the clearance.** Compliance means the aircraft
  happened to already be doing that. Deviation means the instruction was chosen
  to contradict what it was doing.
- **Ground track is not heading.** Wind pushes the aircraft sideways, so a
  track-based heading check is approximate unless `nav_heading` is broadcast.
  Roughly half the traffic in the ring broadcasts it.
- **Ground speed is not indicated airspeed.** Wind makes speed conformance loose.
- **ADS-B coverage degrades at low altitude**, which is exactly where the
  interesting events happen.
- **There is no ground truth.** The output is a candidate for review, not a
  finding. A human stays in the loop.
- Tracks with `seen_pos > 15s` are marked stale and will never be reported as a
  deviation.

The output is **candidate deviations for review**. Never "violation".
