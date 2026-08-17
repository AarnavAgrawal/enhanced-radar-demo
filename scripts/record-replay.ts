// Record a sequence of live snapshots to data/replay-sfo.json.
//
// A venue network is not to be trusted, and neither is adsb.lol being up at the
// exact moment someone is watching. Run this once ahead of time, commit the
// file, and the app works with the network unplugged.
//
//   npm run record:replay              # 10 minutes at 2 s
//   npm run record:replay -- 300 2000  # 300 frames, 2 s apart
//
// Deliberately NOT part of the build. It is a manual step whose output is a
// committed artefact.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fetchTraffic } from '../lib/adsb.ts'
import type { ReplayFile, ReplayFrame } from '../lib/types.ts'

const frameCount = Number(process.argv[2] ?? 300)
const intervalMs = Number(process.argv[3] ?? 2000)

const frames: ReplayFrame[] = []
const startedAt = Date.now()
/** When the first frame actually arrived; all offsets are relative to it. */
let firstAt: number | null = null

console.log(`recording ${frameCount} frames at ${intervalMs} ms (~${Math.round((frameCount * intervalMs) / 60000)} min)`)

for (let i = 0; i < frameCount; i++) {
  const dueAt = startedAt + i * intervalMs
  const wait = dueAt - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))

  try {
    const snap = await fetchTraffic()
    // Offsets are relative to the FIRST frame received, not to when the script
    // started. The opening fetch can take several seconds, and an opening
    // offset of 6 s would put the start of the recording out of reach on
    // playback. Real receive times are kept, so playback runs at the pace the
    // data actually arrived rather than at a nominal cadence it never met.
    firstAt ??= Date.now()
    frames.push({ offsetMs: Date.now() - firstAt, aircraft: snap.aircraft })
    if (i % 15 === 0 || i === frameCount - 1) {
      const pct = Math.round(((i + 1) / frameCount) * 100)
      console.log(`  ${String(pct).padStart(3)}%  frame ${i + 1}/${frameCount}  ${snap.aircraft.length} aircraft`)
    }
  } catch (err) {
    // A dropped frame is fine; playback interpolates over it by holding the
    // previous one. Aborting a nine minute recording over one timeout is not.
    console.log(`  frame ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

if (frames.length === 0) {
  console.error('no frames recorded, refusing to write an empty replay file')
  process.exit(1)
}

const out: ReplayFile = {
  recordedAt: new Date(startedAt).toISOString(),
  intervalMs,
  frames,
}

mkdirSync('data', { recursive: true })
writeFileSync('data/replay-sfo.json', JSON.stringify(out))

const uniqueAircraft = new Set(frames.flatMap((f) => f.aircraft.map((a) => a.hex))).size
const durationMin = ((frames[frames.length - 1].offsetMs) / 60000).toFixed(1)
console.log(`\nwrote data/replay-sfo.json`)
console.log(`  ${frames.length} frames, ${durationMin} min, ${uniqueAircraft} distinct aircraft`)
