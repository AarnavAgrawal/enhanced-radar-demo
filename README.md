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
| 3 | Clearance parser | not started |
| 4 | Conformance engine | not started |
| 5 | The board | not started |
| 6 | Expo hardening (replay mode) | not started |
| 7 | Voice (Deepgram) | not started |

## Running it

Windows, PowerShell:

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Then open http://localhost:3000. No API key is needed for phases 1 and 2 —
adsb.lol is free and unauthenticated.

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

## Layout

```
app/api/traffic/route.ts   proxy to adsb.lol, last-known-good cache
app/page.tsx               the board
lib/adsb.ts                fetch + normalise raw ADS-B into Aircraft
lib/telephony.ts           spoken airline name -> ICAO prefix
lib/callsign.ts            free text -> ICAO callsign -> live aircraft
lib/types.ts               shared data model
```

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
