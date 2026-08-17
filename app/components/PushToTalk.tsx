'use client'

// Talk, then stop talking.
//
// Press once and speak. The recorder listens for you to finish rather than
// making you hold a button, because a controller issuing a clearance has both
// hands busy and the natural end of a transmission is silence. When you stop,
// it transcribes and issues in one move.
//
// Batch rather than streaming: the round trip is under a second, and it keeps
// the Deepgram credential on the server.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscribeResponse } from '../api/transcribe/route'

type Props = {
  /** Called with the transcript. `issue` is true when the caller should act on it. */
  onTranscript: (text: string, issue: boolean) => void
  disabled?: boolean
}

/** Below this RMS the mic is considered quiet. Set by ear against room noise. */
const SILENCE_RMS = 0.012
/** Quiet for this long, after speech has been heard, means the transmission ended. */
const SILENCE_HOLD_MS = 1100
/** Nobody issues a clearance this long. Also stops a hot mic recording forever. */
const MAX_UTTERANCE_MS = 15000
/** Give the speaker this long to start before silence detection can end it. */
const LEAD_IN_MS = 700

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return undefined
}

export function PushToTalk({ onTranscript, disabled }: Props) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [heard, setHeard] = useState(false)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<Extract<TranscribeResponse, { ok: true }> | null>(null)
  const [showKeyterms, setShowKeyterms] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  // Kept between presses so the permission prompt and device warm-up happen once.
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  /** Set when the user cancels, so the recording is dropped rather than sent. */
  const cancelledRef = useRef(false)

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setLevel(0)
  }, [])

  const send = useCallback(
    async (blob: Blob) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': blob.type || 'audio/webm' },
          body: blob,
        })
        const body: TranscribeResponse = await res.json()
        if (!body.ok) {
          setError(body.error)
          return
        }
        setLast(body)
        if (body.transcript) onTranscript(body.transcript, true)
        else setError('Nothing recognised. Move closer to the mic and try again.')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [onTranscript],
  )

  const stop = useCallback(() => {
    stopMeter()
    recorderRef.current?.stop()
    recorderRef.current = null
    setRecording(false)
    setHeard(false)
  }, [stopMeter])

  const start = useCallback(async () => {
    if (recording || busy) return
    setError(null)
    setHeard(false)
    cancelledRef.current = false
    try {
      streamRef.current ??= await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      const stream = streamRef.current
      const mimeType = pickMimeType()
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType })
        if (!cancelledRef.current && blob.size > 0) void send(blob)
      }
      recorderRef.current = rec
      rec.start()
      setRecording(true)

      // Watch the input level so the recording can end itself. Speech has to be
      // heard first, otherwise a moment of silence at the very start would end
      // the transmission before it began.
      audioCtxRef.current ??= new AudioContext()
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') await ctx.resume()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)

      const startedAt = performance.now()
      let lastLoudAt = startedAt
      let hasSpoken = false

      const tick = () => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        const rms = Math.sqrt(sum / buf.length)
        setLevel(rms)

        const nowMs = performance.now()
        if (rms > SILENCE_RMS) {
          lastLoudAt = nowMs
          if (!hasSpoken) {
            hasSpoken = true
            setHeard(true)
          }
        }

        const pastLeadIn = nowMs - startedAt > LEAD_IN_MS
        const wentQuiet = hasSpoken && nowMs - lastLoudAt > SILENCE_HOLD_MS
        const tooLong = nowMs - startedAt > MAX_UTTERANCE_MS
        if ((pastLeadIn && wentQuiet) || tooLong) {
          source.disconnect()
          stop()
          return
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      // Almost always a denied permission, or a page served over plain HTTP.
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone blocked. Allow mic access, or keep using the text box.'
          : err instanceof Error
            ? err.message
            : String(err),
      )
      setRecording(false)
    }
  }, [recording, busy, send, stop])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    stop()
  }, [stop])

  useEffect(() => stopMeter, [stopMeter])

  // Meter fill, eased so quiet speech still shows movement.
  const meter = Math.min(1, Math.sqrt(level / 0.12))

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => (recording ? cancel() : void start())}
          className={
            'relative overflow-hidden border px-4 py-2 font-mono text-xs tracking-wide uppercase transition-colors ' +
            (recording
              ? 'border-signal-fault text-ink'
              : busy
                ? 'border-rule text-ink-faint'
                : 'border-rule-bright text-ink-dim hover:border-ink-dim hover:text-ink')
          }
        >
          {recording && (
            <span
              className="absolute inset-y-0 left-0 bg-signal-fault/25"
              style={{ width: `${meter * 100}%` }}
              aria-hidden
            />
          )}
          <span className="relative">
            {recording
              ? heard
                ? 'Listening, stop speaking to send'
                : 'Listening, go ahead'
              : busy
                ? 'Transcribing'
                : 'Talk'}
          </span>
        </button>

        {recording && (
          <button
            type="button"
            onClick={cancel}
            className="font-mono text-xs text-ink-faint underline decoration-dotted hover:text-ink-dim"
          >
            cancel
          </button>
        )}

        {last && !recording && (
          <span className="font-mono text-xs text-ink-faint tnum">
            {last.elapsedMs} ms
            {last.confidence !== null && ` · ${(last.confidence * 100).toFixed(0)}% conf`} ·{' '}
            <button
              type="button"
              onClick={() => setShowKeyterms((v) => !v)}
              className="underline decoration-dotted hover:text-ink-dim"
            >
              {last.keyterms.length} keyterms from {last.aircraftCovered} live aircraft
            </button>
          </span>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-signal-stale">{error}</p>}

      {/* The keyterm list is the interesting part of using Deepgram, so it is
          inspectable rather than buried in a server log. */}
      {showKeyterms && last && (
        <div className="mt-2 border border-rule bg-bay-sunk p-3">
          <p className="mb-2 text-xs leading-relaxed text-ink-dim">
            Sent with the recording, rebuilt from the traffic picture at the moment you spoke.
            Constraining recognition with the live ADS-B picture is what you would do in production,
            not just in a demo. {last.keytermTokens} words of a 260 word budget.
          </p>
          <p className="font-mono text-[11px] leading-relaxed text-ink-dim">
            {last.keyterms.join('  ·  ')}
          </p>
        </div>
      )}
    </div>
  )
}
