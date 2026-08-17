# Clearance Conformance Monitor

A live clearance conformance monitor for traffic within 40 nm of San Francisco
International (KSFO).

You type an air traffic control clearance at an aircraft that is airborne right
now. The app resolves which aircraft was addressed, binds it to its live ADS-B
track, and reports over the following seconds whether it is doing what it was
told.

> **The aircraft never heard the clearance.** The clearance is synthetic and is
> never transmitted. The aircraft, the ADS-B tracks and the conformance logic
> are real. This is a test harness that lets a human drive the conformance
> engine directly, standing in for a speech recognition pipeline that is out of
> scope here.

The output is **candidate deviations for review**, never "violation". There is
no ground truth in this data, so a human stays in the loop.

---

## Quick start

Requires Node 22.18 or newer, and built on Node 24. The tests run TypeScript
directly through Node's native type stripping, which is on by default from
22.18.

```bash
npm install
cp .env.example .env.local     # PowerShell: Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000.

No API key is needed for anything except voice input. The ADS-B source
(adsb.lol) is free and unauthenticated.

Type a clearance into the command line and press Issue:

```
united 328 climb and maintain one zero thousand
alaska 1340 turn left heading two seven zero
jetblue 416 reduce speed to two one zero
```

The preset buttons fill the box with a worked example built from the traffic
that is actually airborne at the moment you click, so the example lands the way
its label says.

### Tests

```bash
npm test
```

The tests run on Node's built-in runner (`node --test`), so there is no test
framework dependency. That is also why modules inside `lib/` import each other
with explicit `.ts` extensions: Node resolves ES modules strictly and will not
guess the extension.

### Offline / replay mode

```
http://localhost:3000/?replay=1
```

Plays back a committed 10 minute recording of real SFO traffic with no network
at all. The header turns violet, says REPLAY with a frame counter, and names the
date the tracks were recorded, so it cannot be mistaken for live traffic.
Playback loops.

Recorded frames are restamped onto the current clock on playback — otherwise
every aircraft would read as hours stale and the engine would correctly, and
uselessly, report `UNKNOWN` for all of them. `seen_pos` is left as recorded, so
an aircraft that was genuinely stale during the recording still reads as stale.

To record a fresh file:

```bash
npm run record:replay            # 300 frames at 2 s, about 10 minutes
npm run record:replay -- 60 2000 # a shorter one, for testing
```

### Environment

`.env.local` is gitignored; `.env.example` is the template.

| Variable | Needed for | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | Voice input only | Server side only. Do **not** prefix it `NEXT_PUBLIC_`, that would ship the key to the browser. Without it the app runs normally and the talk button returns a clear message. |
| `AIRPLANES_LIVE_ENABLED` | Optional ADS-B fallback | Leave at `0`. airplanes.live requires per-project approval and returns HTTP 403 to unregistered callers. |

### Deploying

Any Next.js host works. On Vercel:

```bash
npm i -g vercel
vercel          # first run links the project
vercel --prod
```

---

## How it works

### Live traffic

`/api/traffic` proxies adsb.lol server side, so the browser never hits the
upstream and there is no CORS problem. The page polls it every 2 seconds. A
single server-side cache serves every connected client and holds the last good
picture, so a failed poll shows a stale badge rather than a blank board.
Roughly 100 to 120 aircraft are usually inside the ring.

`hex`, the ICAO 24 bit address, is the primary key everywhere. It is burned into
the transponder. Callsigns get reused by a different airframe tomorrow.

### Callsign resolution

Free text resolves to a live aircraft:

```
united 969              -> UAL969  hex a2cb32  N27964  B789
united niner six niner  -> UAL969  hex a2cb32  N27964  B789
UAL969                  -> UAL969  hex a2cb32  N27964  B789
N27964                  -> UAL969  hex a2cb32  N27964  B789
```

Accepted forms: telephony name plus flight number (`brickyard 4412`), marketing
name plus flight number (`republic 4412`), digit-at-a-time (`asiana two one
two`), grouped (`united three twenty eight`), ICAO digit words (`niner`, `tree`,
`fife`), a typed ICAO callsign, a typed registration, and a phonetic
registration (`november one seven two sierra papa`). Zero padding is tolerated,
because the same flight files as `UAL328` one day and `UAL0328` the next.

There are three outcomes, and **an ambiguous match is never collapsed into a
guess**:

- `exact` — one live aircraft matches.
- `ambiguous` — more than one matches; every candidate is offered as a button
  and the operator picks.
- `none` — nothing matches, with the reason, plus a "same operator airborne now"
  hint when the airline was understood but that flight number is not up.

### Clearance parsing

A grammar, not a prompt. A grammar can be stepped through at 2am when a verdict
looks wrong.

```
united 328 climb and maintain one zero thousand
   -> { kind: 'ALTITUDE', targetFt: 10000, direction: 'up' }
alaska 1340 turn left heading two seven zero
   -> { kind: 'HEADING', targetDegMag: 270, turn: 'left' }
jetblue 416 reduce speed to two one zero
   -> { kind: 'SPEED', targetKt: 210 }
```

Nine phraseology forms are covered — climb, descend and maintain an altitude,
turn left or right onto a heading, fly heading, and maintain, reduce or increase
speed — plus `flight level two five zero`, `FL250`, typed digits, and the
optional words people drop (`climb maintain 8000`, `reduce speed 180`, `turn
left 270`).

Numbers are normalised the way they are spoken, not the way they are written:
`one zero thousand` and `ten thousand` are both 10,000; `five thousand five
hundred` is 5,500; `twenty five hundred` is 2,500; `zero niner zero` keeps its
leading zero and is 90.

Implausible values are rejected with a reason rather than guessed at: an
altitude that is not a multiple of 100, a heading above 360, a speed of 900 kt,
and `maintain 250` with no unit, which could be either an altitude or a speed.

### Conformance verdicts

`evaluate(clearance, trackBuffer, now)` returns a verdict and a detail line that
names the evidence:

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

A few rules carry most of the weight:

- **Amendments supersede, they do not fail.** A new clearance closes the old one
  as `SUPERSEDED` rather than letting it fail a response window it can no longer
  meet. Without this the board fills with false deviations the moment anyone
  amends anything, which is most of what real ATC does.
- **Stale or missing data returns `UNKNOWN`, never `DEVIATED`.** An aircraft
  whose position is 40 s old is not deviating, it is unobserved.
- **Headings are compared in degrees magnetic.** `nav_heading` is used when the
  autopilot broadcasts it; otherwise ground track is corrected by 13 degrees of
  easterly variation and the detail line says so, because track is not heading
  in a crosswind.
- **Reaching the assigned value does not close a clearance.** "Climb and
  maintain one zero thousand" says *maintain*, so an aircraft that levels at
  10,000 and later drifts off it turns from `COMPLIED` to `DEVIATED`. Leaving a
  value takes a wider band than arriving at it did, so a heading held on the
  edge of tolerance does not flicker between verdicts. `DEVIATED` is terminal:
  it records something that happened at a time.

Every tolerance lives in one exported config object in `lib/conform.ts`:
response window, evaluation window, level band, bust threshold, vertical rate
thresholds, heading and speed tolerances, magnetic variation, and the stale
track cutoff.

### The board

The interface is a **strip bay**, not a radar scope. Controllers work paper
flight progress strips racked in a bay: tinted by function, printed with field
dividers, annotated by hand. One aircraft is one strip.

Colour lives entirely in the strip papers — white pending, buff complying, green
complied, pink deviated, grey superseded, blue unknown — so a bay can be read
from across a room. Everything around them is graphite and hairlines, which
makes the strips the brightest thing on screen.

When a controller amends an instruction they do not erase the old one, they
**cross it out**. A superseded strip is struck through for the same reason, so
it reads as amended rather than failed without anyone having to explain it.

Anything said to an aircraft replaces whatever its strip said before, moves it
to the top of the bay, carries the track forward so the trend line does not
restart, and keeps the previous instruction struck through on the new strip.
Strip matching is on the aircraft alone, while the engine's `supersede` is
narrower on purpose — a speed assignment genuinely does not cancel an altitude
assignment. The trade is deliberate: two strips for one callsign is two things
to reconcile at a glance, so a simultaneous altitude and speed assignment shows
only the later one.

The bay holds eight strips. Closed ones retire after eight minutes, and when the
rack is full closed strips are pulled before open ones, oldest first.

Each strip reports the quantity its clearance is judged on, not always altitude.
A heading clearance shows the current heading and whether it came from the
autopilot's selected heading or from ground track corrected for variation; a
speed clearance shows ground speed and says so, because ATC assigns indicated
airspeed and this is not that. The trend line plots the same quantity, so the
strip, the trace and the evidence line are always talking about one thing.

Altitudes are written in feet below 18,000 ft and as flight levels at or above
it, which is where flight levels begin. A bare hundreds-of-feet readout is
correct only on the scope, where every target is labelled the same way;
anywhere else "096" reads as FL096, and there is no such flight level.

`PENDING` strips show the response window counting down.

### The map

A draggable window, opened from the Map button. Leaflet over a dark CARTO
basemap with the live ADS-B targets drawn on top: a chevron per aircraft
pointing along its ground track, brighter and labelled with callsign, altitude
and ground speed for anything holding a strip. Hover for the full readout, click
a target to put its callsign in the command line, Escape to close. The 40 nm
ring the rest of the app works inside is drawn on it, so the map and the traffic
list are visibly the same picture.

The tiles need the network, which replay mode may not have. If they fail the
panel keeps its dark background, still plots every target, and says "no tiles,
targets only". The basemap is context, not the content.

### Voice input, optional

Press Talk once and speak. The recorder watches the input level and ends the
transmission itself after about a second of silence, then transcribes and issues
in one move — a controller has both hands busy, and the natural end of a
transmission is silence, not a button release. The transcript lands in the same
box you would have typed into and feeds the same parser. Voice is an input
method, not a second code path, and an ambiguous callsign still stops and asks
you to pick. Round trip measures at about 770 ms. The API key never reaches the
browser.

**Keyterm prompting is the reason for using Deepgram.** The keyterm list is
rebuilt on every request from the traffic picture at that moment: the
instruction vocabulary, then telephony names for operators actually within
40 nm, then live callsigns nearest the field first, in both the grouped spoken
form a controller uses ("united twenty three twenty eight") and the digit form.
Constraining recognition with the live ADS-B picture is what you would do in
production, not a demo trick. Click the counter under the talk button to see the
exact list that was sent.

Deepgram caps keyterms at 500 tokens across the whole list and rejects the
entire request with a 400 above that. Measured against the live API: 280 words
accepted, 313 rejected, so their tokenizer splits aviation vocabulary into about
1.8 subword tokens per word. The budget is set to 260 words, which covers around
35 aircraft nearest the field.

`smart_format` and `numerals` are **off**. With them on, Deepgram returns
`"United twenty three twenty eight climb and maintain one zero thousand."`,
capitalised and punctuated. Off, it returns the raw spoken words, which is what
the number normaliser was written and tested against.

An A/B on clean synthetic speech moved confidence from 99.1% to 99.5% and did
not change the transcript. That is the honest result: keyterm prompting is
claimed to earn its keep on noisy audio and unusual callsigns, and a quiet room
with a synthetic voice is neither. It has not been tested in a loud room.
Nova-3 also normalises `tree` to `three` and `fife` to `five` on its own while
leaving `niner` alone; the parser accepts all of them, so this costs nothing.

The text box remains the primary input path.

---

## Layout

```
app/api/traffic/route.ts   proxy to adsb.lol, last-known-good cache
app/api/transcribe/        Deepgram passthrough, key stays server side
app/page.tsx               the board
app/components/            ClearanceStrip, MapPanel, Sparkline, PushToTalk
lib/adsb.ts                fetch + normalise raw ADS-B into Aircraft
lib/telephony.ts           spoken airline name -> ICAO prefix
lib/callsign.ts            free text -> ICAO callsign -> live aircraft
lib/parser.ts              clearance grammar + aviation number normalisation
lib/conform.ts             the verdict engine, pure functions only
lib/board.ts               session state, pure reducer
lib/replay.ts              playback of the committed recording
lib/keyterms.ts            Deepgram keyterm list, built from live traffic
lib/types.ts               shared data model
scripts/record-replay.ts   records data/replay-sfo.json
tests/parser.test.ts       parser and number normalisation
tests/conform.test.ts      verdict engine against synthetic track buffers
```

`lib/parser.ts` and `lib/conform.ts` are pure: no fetch, no clock read, no
React. `evaluate(clearance, buffer, now)` takes the time as an argument, which
is what makes every verdict reproducible and what lets replay mode drive a
synthetic clock. Three of the tests assert that purity by reading the source.

## Stack

Next.js 15 (App Router) and TypeScript in strict mode, Tailwind for styling,
React state for the session, Leaflet for the map, adsb.lol for traffic, and
Deepgram Nova-3 for the optional voice path. No database: the session lives in
the browser.

## Known limitations

State these out loud rather than hoping nobody notices.

- **The aircraft never received the clearance.** Compliance means the aircraft
  happened to already be doing that. Deviation means the instruction was chosen
  to contradict what it was doing.
- **Ground track is not heading.** Wind pushes the aircraft sideways, so a
  track-based heading check is approximate unless `nav_heading` is broadcast.
  Roughly half the traffic in the ring broadcasts it.
- **Ground speed is not indicated airspeed.** Wind makes speed conformance
  loose.
- **ADS-B coverage degrades at low altitude**, which is exactly where the
  interesting events happen.
- **There is no ground truth.** The output is a candidate for review, not a
  finding. A human stays in the loop.
- Tracks with `seen_pos` older than 15 s are marked stale and are never reported
  as a deviation.

## Out of scope

Real ATC audio ingest, audio to ADS-B time alignment, conflict detection between
aircraft, runway incursion and ground conflict detection, accounts, and
persistence. Each is a next step rather than a missing piece.
