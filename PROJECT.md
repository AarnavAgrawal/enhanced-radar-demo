# Clearance Conformance Monitor: full project reference

A live air traffic control clearance conformance monitor for traffic within
40 nm of San Francisco International (KSFO).

You type or speak an ATC clearance at an aircraft that is airborne right now.
The app works out which aircraft you addressed, binds it to its live ADS-B
track, and over the following seconds reports whether the aircraft is doing what
it was told, with the evidence attached.

> **The aircraft never hears the clearance.** It is synthetic and is never
> transmitted. The aircraft, the ADS-B tracks and the conformance logic are all
> real; the instruction is not. This is a test harness that lets a human drive
> the conformance engine directly, standing in for a speech recognition pipeline
> that is out of scope.

Built as a demo for a conversation with Enhanced Radar (YC W25).

---

## 1. What it does

| | Feature | Notes |
|---|---|---|
| 1 | **Live traffic** | Polls adsb.lol every 2 s for everything within 40 nm of KSFO. Typically 100 to 130 aircraft. |
| 2 | **Callsign resolution** | Free text to ICAO callsign to a live airframe. Three outcomes, and ambiguity is never guessed. |
| 3 | **Clearance parsing** | A grammar covering nine ATC phraseology forms plus aviation number normalisation. |
| 4 | **Conformance engine** | Pure verdict function over a track buffer. Six verdicts, each with its evidence. |
| 5 | **The strip bay** | One flight progress strip per aircraft, colour coded by verdict, with a trend line. |
| 6 | **Replay mode** | A committed 10 minute recording, so the demo survives a dead network. |
| 7 | **Voice** | Push to talk with Deepgram, keyterm prompted from the live traffic picture. |
| 8 | **Map** | Draggable Leaflet window with the live targets drawn on a dark basemap. |

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15.5.23, App Router, TypeScript strict | One deploy, one language |
| Runtime | React 19 | Ships with Next 15 |
| Hosting | Vercel (not yet deployed) | Credits held, expiring 2026-09-13 |
| Styling | Tailwind CSS v4 | Tokens declared in `@theme` in `app/globals.css` |
| Type | Archivo and IBM Plex Mono via `next/font` | Self hosted at build time, so no network needed at runtime |
| ADS-B source | adsb.lol v2 | Free, no auth, permissive terms |
| Map | Leaflet 1.9.4 over CARTO dark basemap | No API key, no framework wrapper |
| State | `useReducer` over a pure reducer in `lib/board.ts` | No database needed |
| Speech to text | Deepgram Nova-3, prerecorded endpoint | Keyterm prompting is the deciding feature |
| Tests | `node --test` with native TypeScript type stripping | Zero test framework dependencies |

### Dependencies in full

Runtime, all four of them: `next`, `react`, `react-dom`, `leaflet`.

Dev: `typescript`, `tailwindcss`, `@tailwindcss/postcss`, `eslint`,
`eslint-config-next`, `@eslint/eslintrc`, and the `@types` packages.

That is the entire dependency list. There is no test runner, no state library,
no HTTP client, no charting library, no map framework wrapper, and no UI kit.

### Deliberately not used

- **Azure**: credits not activated.
- **Vapi**: built for phone call agents, wrong shape for browser push to talk.
- **OpenAI Whisper**: no keyword biasing hook, which is the whole reason
  Deepgram wins for this vocabulary.
- **MongoDB**: if persistence is ever added, Supabase Postgres fits time series
  track data better.
- **FlightRadar24**: no free API, they block framing, and scraping breaks their
  terms. The map is built from our own ADS-B feed instead.

---

## 3. Repository layout

```
app/
  api/traffic/route.ts       proxy to adsb.lol, last known good cache, replay serving
  api/transcribe/route.ts    Deepgram passthrough, API key stays server side
  components/
    ClearanceStrip.tsx       one strip, and the strip bay
    MapPanel.tsx             draggable Leaflet window
    PushToTalk.tsx           record, detect silence, transcribe, issue
    Sparkline.tsx            the trend trace on a strip
  globals.css                design tokens in Tailwind @theme
  layout.tsx                 fonts
  page.tsx                   the position: command line, strip bay, traffic list, notes
lib/
  adsb.ts        156   fetch and normalise ADS-B snapshots
  board.ts       278   session state, pure reducer
  callsign.ts    279   free text to a live aircraft
  conform.ts     533   the verdict engine, pure
  format.ts       82   how aviation numbers are written
  keyterms.ts    201   Deepgram keyterm list from live traffic
  parser.ts      324   clearance grammar and number normalisation
  replay.ts       58   playback of the committed recording
  telephony.ts   125   spoken airline name to ICAO prefix
  types.ts       140   the shared data model
scripts/
  record-replay.ts         records data/replay-sfo.json
tests/
  conform.test.ts    502   the engine, against synthetic track buffers
  parser.test.ts     357   the grammar and the number normaliser
data/
  replay-sfo.json    8.6 MB, 300 frames, 10.0 min, 191 distinct aircraft
```

Roughly 2,180 lines of `lib`, 1,540 lines of `app`, 860 lines of tests.

### The rule that shapes the layout

`lib/conform.ts` and `lib/parser.ts` are **pure**. No `fetch`, no clock read, no
React. `evaluate(clearance, buffer, now)` takes the time as an argument.

That is not tidiness for its own sake. It is what makes every verdict
reproducible from its inputs, what lets the tests drive time, and what will let
replay mode drive a synthetic clock. Three of the tests assert that purity by
reading the source file and checking for `Date.now`, `fetch` and React imports.

---

## 4. How a clearance flows through the system

```
  "united 328 climb and maintain flight level 350"
                  |
                  v
  lib/callsign.ts    split callsign from instruction at the first instruction
                     keyword, map "united" to UAL via lib/telephony.ts, read the
                     flight number, match against live traffic
                  |
                  v            exact / ambiguous / none
  lib/parser.ts      parse from the instruction keyword onward against the nine
                     grammar forms; normalise "flight level 350" to 35000 ft
                  |
                  v            { kind: 'ALTITUDE', targetFt: 35000, direction: 'up' }
  lib/board.ts       build a Clearance, pull any existing strip for that
                     aircraft, put the new one at the top of the bay
                  |
                  v
  every 2 s: append a TrackSample, then
  lib/conform.ts     evaluate(clearance, buffer, now) -> { verdict, detail }
                  |
                  v
  the strip         verdict badge, colour coded paper, trend line, evidence line
```

---

## 5. Feature detail

### 5.1 Live traffic

`app/api/traffic/route.ts` proxies `https://api.adsb.lol/v2/lat/37.6188/lon/-122.3750/dist/40`
server side, so the browser never trips CORS and one cached snapshot serves every
connected client.

`lib/adsb.ts` normalises the raw payload into a flat `Aircraft` type:

| Raw field | Becomes | Handling |
|---|---|---|
| `hex` | `hex` | The ICAO 24 bit address. The primary key everywhere. |
| `flight` | `callsign` | Space padded in the ADS-B frame, so it is trimmed. |
| `r` | `registration` | Tail number. |
| `t` | `type` | ICAO type code, e.g. `B739`. |
| `alt_baro` | `altFt` + `onGround` | The literal string `"ground"` becomes `onGround`, not a fake zero. |
| `baro_rate` | `vsFpm` | Falls back to `geom_rate` when barometric is not broadcast. |
| `gs` | `gsKt` | Ground speed. |
| `track` | `trackTrue` | Degrees **true**. |
| `nav_heading` | `navHeading` | Autopilot selected heading, degrees magnetic, when broadcast. |
| `seen_pos` | `seenPosSec` | A missing value is treated as stale, not as fresh. |

**`hex` is the key everywhere.** It is burned into the transponder. Callsigns are
reused by a different airframe tomorrow.

Resilience: the route holds the last snapshot that contained aircraft. A failed
poll shows a stale badge and keeps the picture rather than blanking the board.

`airplanes.live` is listed as a fallback in the original spec but now requires
per project approval and returns HTTP 403 to unregistered callers. The adapter
is written and sits behind `AIRPLANES_LIVE_ENABLED`, off by default.

### 5.2 Callsign resolution

`lib/telephony.ts` maps 87 spoken names onto 59 distinct ICAO prefixes,
including marketing aliases, so "republic 4412" and "brickyard 4412" both reach
RPA4412.

Accepted input forms:

| Input | Resolves via |
|---|---|
| `united 969` | telephony name plus digits |
| `united niner six niner` | ICAO digit words |
| `united three twenty eight` | grouped spoken number |
| `brickyard 4412` / `republic 4412` | telephony name or marketing alias |
| `UAL969` | typed ICAO callsign |
| `N27964` | typed registration |
| `november one seven two sierra papa` | phonetic registration |

Three outcomes, and **an ambiguous match is never collapsed into a guess**:

- `exact`: one live aircraft matches.
- `ambiguous`: more than one matches. Every candidate is shown and the operator
  picks. This holds for voice input too.
- `none`: nothing matches, with the reason, plus a "same operator airborne now"
  hint when the airline was understood but that flight number is not up.

Zero padding is tolerated, because the same flight files as `UAL328` one day and
`UAL0328` the next.

### 5.3 Clearance parsing

A grammar, not a prompt. A grammar can be stepped through at 2 am when a verdict
looks wrong.

The nine forms from ATC phraseology:

```
<callsign> climb and maintain <alt>       ALTITUDE, up
<callsign> descend and maintain <alt>     ALTITUDE, down
<callsign> maintain <alt>                 ALTITUDE, hold
<callsign> turn left heading <hdg>        HEADING, left
<callsign> turn right heading <hdg>       HEADING, right
<callsign> fly heading <hdg>              HEADING, shortest
<callsign> maintain <spd> knots           SPEED
<callsign> reduce speed to <spd>          SPEED
<callsign> increase speed to <spd>        SPEED
```

Optional words people drop are tolerated: `climb maintain 8000`,
`reduce speed 180`, `turn left 270`, `descend to 5000`.

**Number normalisation.** Controllers do not speak normal numbers:

| Spoken | Value |
|---|---|
| `one zero thousand` | 10000 |
| `ten thousand` | 10000 |
| `five thousand five hundred` | 5500 |
| `twenty five hundred` | 2500 |
| `flight level two five zero` | 25000 |
| `FL350` | 35000 |
| `two seven zero` | 270 |
| `zero niner zero` | 90 |
| `niner` / `tree` / `fife` | 9 / 3 / 5 |

Digits accumulate as a **string**, not a running total, because "two five zero"
is 250 and not 2 + 5 + 0, and because the leading zero in "zero niner zero" has
to survive to the end. `thousand` and `hundred` then act as multipliers on
whatever has accumulated.

**What it refuses.** Implausible values are rejected with the reason rather than
guessed at, because they mean the number was misheard, not that the aircraft is
doing something exotic:

- an altitude that is not a multiple of 100
- an altitude outside 1,000 to 45,000 ft
- a heading outside 001 to 360 (there is no heading zero; north is 360)
- a speed outside 100 to 350 kt
- `maintain 250` with no unit, which could be an altitude or a speed

### 5.4 The conformance engine

`evaluate(clearance, buffer, now)` returns a verdict and a detail line.

| Verdict | Meaning |
|---|---|
| `PENDING` | Issued, waiting for the first response. Shows the window counting down. |
| `COMPLYING` | Moving the right way, not there yet. |
| `COMPLIED` | Established at the assigned value. Still monitored. |
| `DEVIATED` | Moving the wrong way, or busted through. Terminal. |
| `SUPERSEDED` | A newer clearance replaced this one. |
| `UNKNOWN` | Track lost, stale data, or no usable reading. |

**Every verdict carries its evidence.** Never a bare verdict:

```
COMPLYING   climbing at 3,136 fpm through 16,925 ft, 3,075 ft to run to the
            assigned 20,000 ft
PENDING     assigned a right turn to 090 deg, no turn yet from 073 deg, 8 s of
            the 20 s window remaining
DEVIATED    assigned descent to 12,000 ft, aircraft is climbing at 3,008 fpm
            at 17,550 ft
```

`DEVIATED` alone is an accusation. With the altitudes and the rate attached it
is an observation someone can check against the same data.

**Tolerances**, all in one exported object in `lib/conform.ts`:

```ts
responseWindowSec: 20     // time allowed to start reacting
evalWindowSec:    120     // time allowed to complete
altLevelBandFt:   200     // counts as level at the assigned altitude
altBustFt:        400     // passed through the assigned altitude
vsRespondingFpm:  300     // vertical rate that counts as a real response
vsLevelFpm:       300     // below this counts as level
hdgToleranceDeg:   10     // counts as established on the assigned heading
spdToleranceKt:    15     // ground speed, wind makes this loose
magVarDeg:         13     // east variation at SFO in 2026
staleTrackSec:     15
hdgRespondingDeg:   5     // a turn this large counts as having started
spdRespondingKt:    5     // a speed change this large counts as a response
driftMultiplier:    2     // leaving an established value takes twice the band
```

**Six decisions in the engine worth knowing:**

1. **Stale data is `UNKNOWN`, never `DEVIATED`.** Staleness is checked two ways:
   `seen_pos` from the receiver, and the age of our own last snapshot. An
   aircraft whose position is 40 s old is not deviating, it is unobserved.

2. **Superseding.** A controller who amends an instruction has not been
   disobeyed. A second clearance closes the first as `SUPERSEDED` rather than
   leaving it open to fail a response window it can no longer meet. Amending is
   most of what real ATC does, so without this the board fills with false
   deviations immediately.

3. **`COMPLIED` stays open.** "Climb and maintain one zero thousand" says
   *maintain*. An aircraft that levels at 10,000 and later drifts off it turns
   `COMPLIED` into `DEVIATED`. Closing the clearance on arrival would make a
   level bust invisible, which is the event most worth catching.

4. **Leaving takes a wider band than arriving.** Established at a heading within
   10 degrees, but it takes 20 degrees to be called off it. Without that
   hysteresis a value held on the edge of tolerance flickers between two
   verdicts every few seconds.

5. **The eval window does not fail an aircraft still trending correctly.** A
   climb from 5,000 to 25,000 ft takes far longer than 120 s. Failing it at the
   window would be a guaranteed false positive on every long climb.

6. **`DEVIATED` is terminal.** It records something that happened at a time, and
   the evidence attached is the evidence as it stood then. Letting it reopen
   would rewrite the finding every two seconds.

**Heading handling.** ATC issues headings in degrees **magnetic**. ADS-B reports
track in degrees **true**. At SFO the variation is about 13 degrees east, so
`magnetic = true - 13`. Skipping this makes every heading verdict wrong by 13
degrees, which is inside a 10 degree tolerance often enough to look almost
right, which is worse than being obviously broken.

`nav_heading` is preferred when broadcast, because it is what the crew dialled
into the autopilot and it is already magnetic. Otherwise ground track is
corrected and the detail line carries the caveat, because wind means track is
not heading.

Turn direction is summed sample to sample rather than measured end to end, so a
turn through north reads as the small turn it was rather than a large one the
other way.

### 5.5 The strip bay

The interface is a **strip bay**, not a dashboard. Controllers work paper flight
progress strips racked in a bay: tinted by function, printed with field
dividers, annotated by hand. One aircraft is one strip.

Colour lives entirely in the strip papers, so the bay can be read from across a
room:

| Verdict | Paper |
|---|---|
| PENDING | white |
| COMPLYING | buff |
| COMPLIED | green |
| DEVIATED | pink |
| SUPERSEDED | grey |
| UNKNOWN | blue |

Everything around them is graphite and hairlines, which makes the strips the
brightest thing on screen.

**One strip per aircraft.** Anything said to an aircraft replaces whatever its
strip said before, moves to the top of the bay, carries the track forward so the
trend line does not restart, and keeps the previous instruction on the new strip
struck through. Matching is on the aircraft alone and ignores verdict status.

The trade is deliberate: a simultaneous altitude and speed assignment to one
aircraft shows only the later one. The engine's `supersede` is narrower and
still correct, because a speed assignment genuinely does not cancel an altitude
assignment. This is a bay display policy, not an engine change.

**Each strip reports the quantity its clearance is judged on**, not always
altitude:

| Clearance | Label | Primary | Secondary |
|---|---|---|---|
| altitude | `altitude` | `10,900 ft` or `FL350` | `+2,304 fpm` or `level` |
| heading | `heading` | `129°` | `autopilot selected` or `from track 137°T` |
| speed | `speed` | `248 kt` | `ground speed` |

The trend line plots the same quantity, so the strip, the trace and the evidence
line are always talking about one thing.

**Capacity.** The bay holds 8 strips. Closed strips retire after 8 minutes, and
when the rack is full closed strips are pulled before open ones, oldest first.
The cap is hard, because `COMPLYING` and `COMPLIED` are both open and a bay that
only drops closed strips grows without limit.

### 5.6 Aviation notation

| Quantity | Written as | Function |
|---|---|---|
| Altitude below 18,000 ft | `9,600 ft` | `formatAltitude` |
| Altitude at or above 18,000 ft | `FL350` | `formatAltitude` |
| Same, unit in the column header | `9,600` / `FL350` | `formatAltitudeShort` |
| Vertical distance | `3,000 ft`, always | `formatFeet` |
| Radar data block | `096`, hundreds of feet | `altitudeTag` |
| Heading | `090`, three digits | `formatHeading` |

18,000 ft is the US transition altitude. Below it an aircraft flies an
**altitude** against the local altimeter setting. At and above it everyone sets
29.92 inHg and flies a **flight level**. Same measurement, different reference,
different notation.

A bare hundreds of feet readout is correct **only** on the scope, where every
target is labelled the same way. Anywhere else `096` reads as FL096, and the
lowest usable flight level in the US is FL180, so no such level exists.

Vertical distances are never flight levels: "3,000 ft to run" is a gap between
two altitudes and FL030 would be nonsense. `formatFeet` exists separately so
that distinction cannot be lost by accident.

Phraseology: `climb and maintain FL350`, not `climb to`. `turn left heading
270`, not `turn left to heading 270`. `maintain 250 knots`, not `250 kt`.

### 5.7 Replay mode

```
http://localhost:3000/?replay=1
```

Runs the entire app off a committed recording with no network at all. The status
row shows the replay position and the date the tracks were recorded, so nobody
watching can mistake it for live traffic. Playback loops, because a demo that
dies after ten minutes dies in the middle of a conversation.

The committed file is 300 frames over 10.0 minutes, 191 distinct aircraft,
8.6 MB. It contains a good demo subject: **UAL2279, an A319, flies a complete
arrival**, descending from 15,125 ft to 2,200 ft across the whole recording.

To re-record:

```powershell
npm run record:replay             # 300 frames at 2 s, about 10 minutes
npm run record:replay -- 60 2000  # a short one for testing
```

Two implementation points that were bugs first:

- **The playhead lives in the client**, passed to the server as elapsed
  milliseconds. Server module scope does not survive a hot reload in dev or a
  cold start on Vercel, and a playhead that resets on every request never leaves
  the first frame.
- **Offsets are measured from the first frame received**, not from when the
  script started. An opening fetch that takes six seconds would otherwise put
  the start of the recording permanently out of reach. `frameAt` also normalises
  defensively, so an already recorded file still plays.

Recorded frames are restamped onto the current clock on playback, or every
aircraft would read as hours stale and the engine would correctly, and
uselessly, report `UNKNOWN` for all of them. `seen_pos` is left as recorded, so
an aircraft that was genuinely stale during the recording still reads as stale.

`next.config.ts` traces `data/replay-sfo.json` into the `/api/traffic` bundle.
The file is read with `fs` rather than imported, so Next cannot see it and would
otherwise ship a serverless function without it: replay would work locally and
500 on Vercel.

### 5.8 Voice

Press **Talk** once and speak. An `AnalyserNode` watches the input level and
ends the transmission after about a second of silence, then transcribes and
issues in one move. A controller has both hands busy and the natural end of a
transmission is silence, not a button release.

Speech has to be heard before silence can end it, so a pause before starting
does not cut it off, and a hot mic is capped at 15 seconds. Round trip measured
at about 770 ms.

Voice never forces a guess: an ambiguous callsign stops and asks you to pick,
exactly as typing one does.

**Keyterm prompting is the reason for choosing Deepgram.** The keyterm list is
rebuilt on every request from the traffic picture at that moment:

1. The instruction vocabulary, which appears in every clearance.
2. Telephony names for operators actually within 40 nm. A name nobody is about
   to say is spending budget a nearby callsign could use.
3. Live callsigns, nearest the field first, in both the grouped spoken form a
   controller uses ("united twenty three twenty eight") and the digit form.

Constraining recognition with the live ADS-B picture is what you would do in
production, not a demo trick. Click the counter under the Talk button to see the
exact list that was sent.

**The cap is not what it looks like.** Deepgram allows 500 tokens across the
whole keyterm list, not 500 keyterms, and rejects the entire request with a 400
above it. A first list of 193 aviation callsigns was well over. Their tokens are
also not our words: measured against the live API, **280 words was accepted and
313 was rejected**, so aviation vocabulary splits into roughly 1.8 subword
tokens per word. The budget is set to 260 words, covering about 35 aircraft.

**`smart_format` and `numerals` are off.** With them on, the same audio returns
`"United twenty three twenty eight climb and maintain one zero thousand."`,
capitalised and punctuated. Off, it returns the raw spoken words, which is what
the normaliser was tested against.

The API key never reaches the browser.

### 5.9 The map

A draggable window opened from the **Map** button. Leaflet over a dark CARTO
basemap with the live ADS-B targets drawn on top: a chevron per aircraft
pointing along its ground track, brighter and labelled with callsign, altitude
and ground speed for anything holding a strip. Hover for the full readout, click
a target to put its callsign in the command line, `[+]` to enlarge, Escape to
close.

The 40 nm ring the rest of the app works inside is drawn on it, so the map and
the traffic list are visibly the same picture.

It is not an embed of FlightRadar24: they have no free API, they block framing,
and scraping breaks their terms. This shows the same picture from the same kind
of data, sourced the way the rest of the app sources it.

The tiles need the network, which replay mode may not have. On tile failure the
panel keeps its dark background, still plots every target, and says
`no tiles, targets only`. The basemap is context, not the content.

---

## 6. Running it

Windows, PowerShell:

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. No API key is needed for anything except voice.

| Command | What it does |
|---|---|
| `npm run dev` | Development server on port 3000 |
| `npm run build` | Production build |
| `npm test` | 123 tests, under a second |
| `npm run lint` | ESLint |
| `npm run record:replay` | Records a new `data/replay-sfo.json` |

**Stop the dev server before running `npm run build`.** Both write to `.next`,
and running them together produces confusing `Cannot find module for page`
errors that have nothing to do with your code.

If the app ever returns a 500, it is almost always a stale build cache:

```powershell
Remove-Item -Recurse -Force .next
npm run dev
```

### Environment

`.env.local` is gitignored. `.env.example` is the committed template.

| Variable | Needed for | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | Voice only | Server side only. Never prefix `NEXT_PUBLIC_`. Without it the app runs fine and the Talk button returns a clear message. |
| `AIRPLANES_LIVE_ENABLED` | Optional ADS-B fallback | Leave `0`. airplanes.live now requires per project approval. |

### Deploying

```powershell
npm i -g vercel
vercel          # first run links the project
vercel --prod
```

Test the deployed URL on a phone over **cell data, not wifi**. The venue network
is the thing most likely to fail, and cell data is the closest thing to it.

Voice needs `localhost` or HTTPS for microphone access. It works on localhost
and on Vercel, but not over plain HTTP to a laptop's IP from a phone.

---

## 7. Tests

123 tests, all on Node's built in runner with native TypeScript type stripping.
No test framework is installed. That is why modules inside `lib/` import each
other with explicit `.ts` extensions: Node resolves ES modules strictly and will
not guess the extension.

Only `lib/parser.ts` and `lib/conform.ts` are tested, deliberately. They are the
files where the logic lives and the only ones that are straightforward to test.

`tests/parser.test.ts` covers every row of the number normalisation table, all
nine grammar forms, the rejection cases, and how altitudes are written back out.

`tests/conform.test.ts` covers correct climb, wrong direction, level off, bust,
stale data, superseded, the heading and speed paths, established clearances that
later drift, and three tests that assert `conform.ts` is pure by reading its
source.

---

## 8. Known limitations, to be stated out loud

Naming your own failure modes is more persuasive than a clean demo.

- **The aircraft never received the clearance.** Compliance means the aircraft
  happened to already be doing that. Deviation means the instruction was chosen
  to contradict what it was doing.
- **Ground track is not heading.** Wind pushes the aircraft sideways, so a track
  based heading check is approximate unless `nav_heading` is broadcast. Roughly
  half the traffic in the ring broadcasts it.
- **Ground speed is not indicated airspeed.** ATC assigns IAS; ADS-B reports
  ground speed, and the difference is the wind, often 80 kt or more at altitude.
- **ADS-B coverage degrades at low altitude**, which is exactly where the
  interesting events happen.
- **There is no ground truth.** The output is a candidate for review, not a
  finding. A human stays in the loop.
- **Keyterm prompting is unproven here.** On clean synthetic speech it moved
  confidence from 99.1% to 99.5% and did not change the transcript. The claim is
  that it earns its keep on noisy audio and unusual callsigns, and a quiet room
  with a synthetic voice is neither. It has not been tested in a loud hall.
- **Only one constraint per aircraft is displayed**, by design of the bay.
- **The map basemap needs the network.** Targets still plot without it.

The phrase is **candidate deviations for review**. Never "violation".

---

## 9. What is not built

Out of scope by design, and the honest answer to "what is next":

- Real ATC audio ingest and transcription
- Audio to ADS-B time alignment
- Runway incursion or ground conflict detection, which Enhanced Radar already
  ships
- Conflict detection between aircraft
- Authentication, accounts, billing
- A database
- Deepgram streaming (7b). Batch push to talk is solid and streaming would add a
  token minting endpoint for marginal gain at a demo.

---

## 10. Commit history

The build order follows the seven phase plan the project was specified against.

```
4a23beb  Report the quantity each clearance is actually judged on
4c31764  Drop the header, put a real map in the window, one strip per aircraft
2126f4c  Add a draggable scope, correct the altitude notation, replace amended strips
14e8d32  Redesign as a strip bay, flight levels in prose, and voice that issues itself
605dce1  Phase 7a: push to talk, with keyterm prompting from the live traffic picture
c606576  README: morning-of checklist
1dd14f5  Phase 6: commit the replay recording, and stamp arrival on the client
23f5dcf  Phase 6: expo hardening, replay mode and presets
2f0a590  Phase 5: the board
c70622b  Phase 4: the conformance engine
9d5224e  Phase 3: clearance parser
0b9a6c0  Phases 1-2: live SFO traffic feed and callsign resolution
```

---

## 11. Bugs found by running it, not by reading it

Worth keeping, because each one was invisible until real data went through it.

| Bug | Why it mattered |
|---|---|
| `twenty five hundred` parsed as 20500 | A tens word concatenated instead of combining with the unit. Caught by a test written before the parser. |
| `COMPLIED` was terminal | A "maintain 16,000" clearance stopped collecting track the moment it was satisfied, so it could never report a level bust, the event most worth catching. |
| Replay playhead in server module scope | Reset on every request, so playback never left frame 1. Would have failed identically on Vercel cold starts. |
| Replay offsets started at 6,578 ms | The recorder stamped each frame after its fetch returned, putting the start of the recording out of reach. |
| `ts` stamped by the server | A phone with a fast clock would mark every aircraft `UNKNOWN`, and it would fail only on the device the demo was given from. |
| Replay JSON not traced into the bundle | Read with `fs`, so Next left it out. Replay would work locally and 500 on Vercel. |
| Deepgram keyterm cap is 500 **tokens** | Not 500 keyterms. A 193 callsign list was well over and would have 400'd the whole request mid demo. |
| `font-600` is not a Tailwind class | Every heavy weight in the redesign was silently rendering at normal. |
| The strip cap was not a cap | It refused to drop open strips, and `COMPLYING` and `COMPLIED` are both open, so the bay grew without limit. |
| One strip per aircraft failed on closed strips | The replace rule only fired on open clearances, so a `DEVIATED` strip survived and a second clearance opened a second strip. |
