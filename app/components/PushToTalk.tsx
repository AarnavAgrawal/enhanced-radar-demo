'use client'

// Hold to talk. See CLAUDE.md phase 7a.
//
// Batch rather than streaming: the round trip is about a second, which is fine
// when you are holding a button, and it avoids handing the browser a Deepgram
// credential. The text box stays the primary path -- expo halls are loud and
// this will not always work.

import { useCallback, useRef, useState } from 'react'
import type { TranscribeResponse } from '../api/transcribe/route'

type Props = {
  /** Called with the transcript, which goes into the same box you would type into. */
  onTranscript: (text: string) => void
  disabled?: boolean
}

/** The first container the browser will actually record. Chrome and Safari differ. */
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
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<Extract<TranscribeResponse, { ok: true }> | null>(null)
  const [showKeyterms, setShowKeyterms] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  // The mic stream is kept between presses, so the permission prompt and the
  // device warm-up happen once rather than on every push.
  const streamRef = useRef<MediaStream | null>(null)

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
        if (body.transcript) onTranscript(body.transcript)
        else setError('nothing recognised, try again closer to the mic')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [onTranscript],
  )

  const start = useCallback(async () => {
    if (recording || busy) return
    setError(null)
    try {
      streamRef.current ??= await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      const rec = new MediaRecorder(streamRef.current, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType })
        if (blob.size > 0) void send(blob)
      }
      recorderRef.current = rec
      rec.start()
      setRecording(true)
    } catch (err) {
      // Almost always a denied permission or a page not on HTTPS.
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [recording, busy, send])

  const stop = useCallback(() => {
    if (!recording) return
    recorderRef.current?.stop()
    setRecording(false)
  }, [recording])

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || busy}
          onPointerDown={(e) => {
            e.preventDefault()
            void start()
          }}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          className={
            'select-none rounded px-4 py-2 text-sm font-medium transition-colors ' +
            (recording
              ? 'bg-red-700 text-white'
              : busy
                ? 'bg-slate-700 text-slate-400'
                : 'border border-slate-700 text-slate-300 hover:border-slate-500')
          }
        >
          {recording ? '● recording, release to send' : busy ? 'transcribing…' : '🎙 hold to talk'}
        </button>

        {last && (
          <span className="font-mono text-xs text-slate-500">
            {last.elapsedMs} ms
            {last.confidence !== null && ` · confidence ${(last.confidence * 100).toFixed(0)}%`}
            {' · '}
            <button
              type="button"
              onClick={() => setShowKeyterms((v) => !v)}
              className="underline decoration-dotted hover:text-slate-300"
            >
              {last.keyterms.length} keyterms, {last.keytermTokens} words, {last.aircraftCovered}{' '}
              live aircraft
            </button>
          </span>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-amber-400">{error}</p>}

      {/* The keyterm list is the interesting part, so it is inspectable rather
          than buried in a server log. */}
      {showKeyterms && last && (
        <div className="mt-2 rounded border border-slate-800 bg-slate-950 p-3">
          <p className="mb-2 text-xs text-slate-500">
            Sent to Deepgram with this recording, built from the traffic picture at the moment you
            spoke. Constraining recognition with the live ADS-B picture is what you would do in
            production, not just in a demo.
          </p>
          <p className="font-mono text-xs leading-relaxed text-sky-300">
            {last.keyterms.join(' · ')}
          </p>
        </div>
      )}
    </div>
  )
}
