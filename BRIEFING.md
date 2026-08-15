# Briefing: what to know before you demo this

Read this once tonight and skim it again in the morning. `PROJECT.md` has
everything; this has only what you need in your head when someone is standing in
front of you asking questions.

---

## The one sentence

> It takes an ATC clearance in plain speech, works out which real aircraft you
> addressed, and tells you within seconds whether that aircraft is doing what it
> was told, with the evidence attached.

## The second sentence, and say it before they ask

> The aircraft never hears the clearance. It is synthetic and never transmitted.
> The aircraft, the tracks and the logic are real; the instruction is not.

Saying this first is the whole credibility of the demo. If you let someone
believe you are transmitting to real aircraft for thirty seconds and then
correct them, you have lost them. Lead with it every time.

---

## The five minute demo, in order

1. **Let the traffic list populate.** About 110 aircraft near SFO, numbers
   moving on their own. "This is live ADS-B, two second poll."

2. **Click a preset**, for example `climb · complies`. It fills the box with a
   real callsign that is climbing right now. Press Issue.
   - A strip appears: PENDING, with the 20 second window counting down.
   - It turns COMPLYING with a line like *"climbing at 2,304 fpm through 8,725
     ft, 1,275 ft to run to the assigned 10,000 ft"*.

3. **Click `descend · deviates`.** Same aircraft type of thing, instruction
   chosen to contradict what it is doing. Goes red fast.
   - Say: *"I picked an instruction I knew it would not follow. That is the
     honest way to demo a deviation detector without a transmitter."*

4. **Amend one.** Issue a second clearance to an aircraft that already has a
   strip. The strip is replaced in place, moves to the top, and shows the old
   instruction struck through.
   - Say: *"A controller who amends has not been disobeyed. If you do not handle
     this, the board fills with false deviations, because amending is most of
     what real ATC does."*

5. **Press Talk and say a clearance.** Stop talking; it sends and issues itself.
   Then click the keyterm counter that appears.
   - Say: *"That list is rebuilt from the live traffic picture every time you
     speak. We tell the recogniser which callsigns are physically within 40 nm
     before it listens."*

6. **Open the Map** if there is time. Click a target to address it.

If the network is bad, add `?replay=1` and carry on. Say out loud that it is a
recording; the status row says so too.

---

## The three things that make it more than a toy

These are what you actually want to talk about. Everything else is plumbing.

### 1. Ambiguity is never resolved by guessing

Three outcomes: `exact`, `ambiguous`, `none`. If two live aircraft could be the
one you addressed, you get both and you pick. Voice input included.

> *"A tool that quietly picks one of two similar callsigns for you is worse than
> one that asks. In this domain a confident wrong answer is the expensive kind."*

### 2. Amendment is not disobedience

A second clearance to an aircraft replaces the first. The old one closes rather
than failing a response window it can no longer meet.

> *"This is the single detail that separates a working engine from one that
> emits constant false positives."*

### 3. Unobserved is not the same as non-compliant

A track older than 15 seconds returns `UNKNOWN`, never `DEVIATED`. Two separate
staleness checks: the receiver's `seen_pos`, and the age of our own snapshot.

> *"An aircraft whose position is 40 seconds old is not deviating. It is
> unobserved. Collapsing those two into one answer is how a monitoring tool
> quietly stops being trustworthy."*

---

## Aviation details a pilot will check

Your audience has 2,500 hours. These are the things that get noticed in the
first ten seconds.

| Thing | What we do | Why it matters |
|---|---|---|
| **Magnetic variation** | `magnetic = true - 13` at SFO | ATC issues headings magnetic; ADS-B reports track true. Getting it wrong makes every heading verdict off by 13 degrees, which is inside a 10 degree tolerance often enough to look almost right. |
| **Track is not heading** | `nav_heading` preferred; otherwise corrected track with the caveat shown | Wind pushes the aircraft sideways. The crab angle is the difference. |
| **Ground speed is not IAS** | Every speed verdict says "ground speed" | ATC assigns indicated airspeed. The difference is the wind, often 80 kt at altitude. |
| **Flight levels start at FL180** | Feet below 18,000, `FL350` at or above | There is no FL096. Hundreds of feet is correct only on a scope. |
| **Heading 360, never 000** | Rejected as invalid | North is assigned as "heading three six zero". |
| **Phraseology** | "climb and maintain FL350", "turn left heading 270", "maintain 250 knots" | Not "climb to", not "turn left to heading". |
| **niner, tree, fife** | Parsed | And Deepgram already normalises tree and fife by itself, while leaving niner alone. |

---

## The stack, in one breath

Next.js 15 with the App Router, TypeScript strict, Tailwind v4, deployed on
Vercel. Live data from adsb.lol, polled through a server route so the browser
never trips CORS. Leaflet for the map. Deepgram Nova-3 for speech. State is a
pure reducer, no database.

**The whole runtime dependency list is four packages.** No test runner, no state
library, no HTTP client, no charting library, no UI kit.

If asked why: every dependency is a thing that can break on the morning of a
demo, and most of what this app does is arithmetic on numbers that arrive every
two seconds.

---

## The architectural point worth making

`lib/conform.ts` is pure. No `fetch`, no clock read, no React.

```ts
evaluate(clearance, trackBuffer, now) -> { verdict, detail }
```

`now` is an argument, not `Date.now()`.

> *"Every verdict is reproducible from its inputs. You can replay a track buffer
> and get the same answer, which is what you need if the output is ever going to
> be reviewed by a human who disagrees with it."*

Three of the tests assert that purity by reading the source file and checking
for `Date.now`, `fetch` and React imports. 123 tests total, all on Node's built
in runner. No test framework installed.

---

## Numbers to have ready

| | |
|---|---|
| Aircraft in the ring | 100 to 130 |
| Poll interval | 2 seconds |
| Response window | 20 seconds |
| Level band | ±200 ft |
| Heading tolerance | ±10 degrees |
| Magnetic variation at SFO | 13 degrees east |
| Airlines in the telephony table | 87 spoken names, 59 ICAO prefixes |
| Voice round trip | about 770 ms |
| Deepgram keyterm budget | 500 tokens, which is about 280 words |
| Tests | 123 |
| Replay recording | 300 frames, 10 minutes, 191 aircraft |

---

## Questions you will probably get

**"How do you know it is the right aircraft?"**
Callsign to ICAO prefix to a live `flight` field, keyed on the ICAO 24 bit
address. Callsigns get reused by a different airframe tomorrow; the hex address
is burned into the transponder. If two aircraft match, we show both.

**"What happens when the data is bad?"**
`UNKNOWN`, never `DEVIATED`. And a failed poll holds the last known picture with
a stale badge rather than blanking the board.

**"Would this work on real audio?"**
Not yet, and that is the honest answer. This is a text harness that lets a human
drive the engine directly. Real ATC audio ingest and audio to ADS-B time
alignment are the next two problems, and they are both hard.

**"Does the keyterm prompting actually help?"**
On clean synthetic speech it moved confidence from 99.1% to 99.5% and did not
change the transcript. It has not been tested in a loud room. The architectural
argument stands on its own: constraining recognition with the live picture is
what you would do in production. Do not claim an accuracy win you cannot show.

**"Why not FlightRadar24 for the map?"**
No free API, they block framing, and scraping breaks their terms. The map is
built from the same ADS-B feed as everything else.

**"How long did this take?"**
One night. Say it plainly; it is a point in your favour, not against.

---

## What to admit before they find it

Volunteering your own failure modes is more persuasive than a clean demo. Pick
two or three of these, do not recite the list.

- The aircraft never received the clearance. Compliance means it happened to
  already be doing that.
- Ground track is not heading, and roughly half the traffic broadcasts a
  selected heading.
- Ground speed is not indicated airspeed.
- ADS-B coverage degrades at low altitude, which is where the interesting events
  happen.
- There is no ground truth, so this produces **candidate deviations for review**,
  not findings. Never say "violation".
- Keyterm prompting is unproven in a noisy room.
- Only one instruction per aircraft is shown, by design of the bay.

That last framing, candidate for review with a human in the loop, matches how
Enhanced Radar positions its own post operation review product. Use their
language.

---

## The morning checklist

1. `npm test`. Under a second. If it fails, do not demo.
2. Open the deployed URL **on your phone over cell data**, not wifi.
3. Click a preset, press Issue, watch a verdict land. Fifteen seconds, exercises
   the whole chain.
4. Open `?replay=1` once so you know what it looks like before you need it.
5. Check the Deepgram key is still set if you plan to use voice.

Traffic near SFO is thinnest around 04:00 local and busy from about 06:00. A
morning expo is fine.

**Stop the dev server before running `npm run build`.** They both write to
`.next` and produce confusing errors together.

---

## Two loose ends

- **Not deployed yet.** `npx vercel` then `npx vercel --prod`, then test on your
  phone over cell data.
- **Rotate the Deepgram key** after the expo. It was pasted into a chat
  transcript.
