# Clearance Conformance Monitor

**Live: https://enhanced-radar-demo.vercel.app/**

Type an ATC clearance at an aircraft that is airborne right now within 40 nm of
SFO. The app resolves which aircraft was addressed, binds it to its live ADS-B
track, and reports whether it is doing what it was told.

> The aircraft never heard the clearance. The clearance is synthetic and is
> never transmitted. The aircraft, the tracks and the conformance logic are
> real. Output is a candidate for review, not a finding.

## Run it

Node 22.18 or newer.

```bash
npm install
cp .env.example .env.local     # PowerShell: Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000. No API key is needed except for voice; adsb.lol is
free and unauthenticated.

## Use it

Type a clearance and press Issue:

```
united 328 climb and maintain one zero thousand
alaska 1340 turn left heading two seven zero
jetblue 416 reduce speed to two one zero
```

- Callsigns: telephony or marketing name plus flight number (`brickyard 4412`,
  `republic 4412`), spoken digits (`united niner six niner`), a typed callsign
  (`UAL969`), or a registration (`N27964`).
- Instructions: climb, descend and maintain an altitude; turn left or right
  heading; fly heading; maintain, reduce or increase speed.
- If more than one aircraft matches, pick from the buttons. The app never
  guesses.
- The preset buttons fill the box from live traffic. **Map** opens the traffic
  picture; click a target to load its callsign. **Talk** needs a Deepgram key.

## Tests

```bash
npm test
```

## Replay mode

```
http://localhost:3000/?replay=1
```

Plays back a committed 10 minute recording of real SFO traffic, no network
needed. The header turns violet and says REPLAY. To record a fresh file:

```bash
npm run record:replay            # 300 frames at 2 s
npm run record:replay -- 60 2000 # a shorter one
```

## Environment

| Variable | Needed for |
|---|---|
| `DEEPGRAM_API_KEY` | Voice input. Server side only, never prefix it `NEXT_PUBLIC_`. |
| `AIRPLANES_LIVE_ENABLED` | Optional ADS-B fallback. Leave at `0`; airplanes.live returns 403 to unregistered callers. |

## Deploy

```bash
npm i -g vercel
vercel          # first run links the project
vercel --prod
```

## Layout

```
app/api/traffic/    proxy to adsb.lol, last-known-good cache
app/api/transcribe/ Deepgram passthrough, key stays server side
app/page.tsx        the board
lib/callsign.ts     free text -> ICAO callsign -> live aircraft
lib/parser.ts       clearance grammar + aviation number normalisation
lib/conform.ts      the verdict engine, pure functions only
lib/keyterms.ts     Deepgram keyterms, built from live traffic
```

`parser.ts` and `conform.ts` are pure: no fetch, no clock read, no React.
`evaluate(clearance, buffer, now)` takes the time as an argument, so every
verdict is reproducible.
