// Playback of a recorded snapshot sequence. See CLAUDE.md phase 6.
//
// Expo wifi is not to be trusted and neither is an upstream being up at the
// moment somebody is watching. With ?replay=1 the app runs off a committed
// recording and needs no network at all.
//
// The frame selection is pure, so it is driven by a clock passed in rather than
// one read here, exactly like the conformance engine.

import type { Aircraft, ReplayFile, TrackSample } from './types.ts'

/**
 * Pick the frame for a moment in playback, looping when it runs off the end.
 *
 * Looping matters more than it sounds: a demo that dies after ten minutes dies
 * in the middle of a conversation.
 */
export function frameAt(replay: ReplayFile, elapsedMs: number): { aircraft: Aircraft[]; index: number } {
  const frames = replay.frames
  // Normalise against the first frame rather than trusting it to sit at zero.
  // The recorder stamps a frame when the snapshot arrives, and the first fetch
  // of a run can take several seconds, which would otherwise put the whole
  // recording out of reach until playback had run that far.
  const base = frames[0].offsetMs
  const span = frames[frames.length - 1].offsetMs - base
  const total = span + replay.intervalMs
  const t = ((elapsedMs % total) + total) % total

  // Frames are in order, so a scan from the end finds the most recent frame at
  // or before t. A frame dropped during recording is held over rather than
  // interpolated, which is what a real feed does when it misses an update.
  // Before the first frame we are in the wrap, so the last frame still applies.
  let index = frames.length - 1
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].offsetMs - base <= t) {
      index = i
      break
    }
  }
  return { aircraft: frames[index].aircraft, index }
}

/**
 * Restamp a recorded frame onto the current clock.
 *
 * Without this every replayed aircraft looks hours stale and the engine would
 * correctly, and uselessly, report UNKNOWN for all of them. `seen_pos` is left
 * as recorded, so an aircraft that was genuinely stale during the recording
 * still reads as stale on playback.
 */
export function restamp(aircraft: Aircraft[], now: number): Aircraft[] {
  return aircraft.map((a) => ({ ...a, ts: now }))
}

/** Same restamping for a bare sample, kept here so the rule lives in one place. */
export function restampSample(s: TrackSample, now: number): TrackSample {
  return { ...s, ts: now }
}
