// Push to talk, batch. See CLAUDE.md phase 7a.
//
// The browser records while a button is held and posts the blob here. This
// route forwards it to Deepgram's prerecorded endpoint and hands the transcript
// straight to the same parser the text box uses, so voice is an input method
// and not a second code path.
//
// The API key stays server side. It is never sent to the browser.

import { NextResponse } from 'next/server'
import { fetchTraffic, SFO } from '@/lib/adsb'
import { buildKeyterms } from '@/lib/keyterms'
import type { Aircraft } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export type TranscribeResponse =
  | {
      ok: true
      transcript: string
      confidence: number | null
      /** Shown in the UI, because constraining recognition is the point. */
      keyterms: string[]
      keytermTokens: number
      aircraftCovered: number
      elapsedMs: number
    }
  | { ok: false; error: string }

export async function POST(request: Request) {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) {
    return NextResponse.json(
      { ok: false, error: 'DEEPGRAM_API_KEY is not set. Voice is optional; the text box still works.' } satisfies TranscribeResponse,
      { status: 503 },
    )
  }

  const audio = await request.arrayBuffer()
  if (audio.byteLength === 0) {
    return NextResponse.json(
      { ok: false, error: 'no audio received, hold the button while speaking' } satisfies TranscribeResponse,
      { status: 400 },
    )
  }
  const contentType = request.headers.get('content-type') ?? 'audio/webm'

  // Build the keyterm list from the traffic picture as it is right now, so the
  // recogniser is biased toward callsigns that are actually within 40 nm. This
  // is regenerated per request rather than cached: the point is that it tracks
  // the live picture.
  let traffic: Aircraft[] = []
  try {
    traffic = (await fetchTraffic()).aircraft
  } catch {
    // No traffic picture is a degraded keyterm list, not a failed transcription.
    // The instruction vocabulary alone is still worth passing.
  }
  const keyterms = buildKeyterms(traffic, SFO)

  const params = new URLSearchParams({
    model: 'nova-3',
    // Aviation numbers do not follow normal conventions. Smart formatting would
    // turn "one zero thousand" into "10,000" and "niner" into "9", and the
    // parser has been tested against the spoken words, not against a formatter's
    // guess at them. Consistent raw input beats pre-formatted input.
    smart_format: 'false',
    numerals: 'false',
    punctuate: 'false',
  })
  for (const term of keyterms.terms) params.append('keyterm', term)

  const startedAt = Date.now()
  try {
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': contentType },
      body: audio,
      signal: AbortSignal.timeout(20000),
    })
    const body = await res.json()
    if (!res.ok) {
      const message = body?.err_msg ?? body?.error ?? `Deepgram returned HTTP ${res.status}`
      return NextResponse.json({ ok: false, error: message } satisfies TranscribeResponse, { status: 502 })
    }

    const alt = body?.results?.channels?.[0]?.alternatives?.[0]
    return NextResponse.json({
      ok: true,
      transcript: (alt?.transcript ?? '').trim(),
      confidence: typeof alt?.confidence === 'number' ? alt.confidence : null,
      keyterms: keyterms.terms,
      keytermTokens: keyterms.tokens,
      aircraftCovered: keyterms.aircraftCovered,
      elapsedMs: Date.now() - startedAt,
    } satisfies TranscribeResponse)
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) } satisfies TranscribeResponse,
      { status: 502 },
    )
  }
}
