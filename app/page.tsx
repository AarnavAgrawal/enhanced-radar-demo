'use client'

// The position: a command line, a strip bay, and the traffic it is watching.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Aircraft, ReplayPosition, TrafficResponse } from '@/lib/types'
import { resolveCallsign, suggestSameAirline } from '@/lib/callsign'
import { parseInstruction, describeConstraint } from '@/lib/parser'
import { TOL } from '@/lib/conform'
import { boardReducer, initialBoardState, makeClearance } from '@/lib/board'
import { altitudeTag, formatAltitude, formatHeading, formatVerticalRate } from '@/lib/format'
import { StripBay } from './components/ClearanceStrip'
import { PushToTalk } from './components/PushToTalk'

const POLL_MS = 2000

/**
 * Worked examples, so nobody is typing a clearance while also talking. The
 * callsign is filled from the live picture at click time rather than hardcoded,
 * because a flight number airborne tonight will not be airborne tomorrow, and
 * each one picks an aircraft in a state that makes the example land as labelled.
 */
const PRESETS: { label: string; instruction: string; pick: (a: Aircraft) => boolean }[] = [
  {
    label: 'climb · complies',
    instruction: 'climb and maintain',
    pick: (a) => (a.vsFpm ?? 0) > 800 && (a.altFt ?? 0) > 3000,
  },
  {
    label: 'descend · deviates',
    instruction: 'descend and maintain',
    pick: (a) => (a.vsFpm ?? 0) > 800 && (a.altFt ?? 0) > 8000,
  },
  {
    label: 'maintain · complies',
    instruction: 'maintain',
    pick: (a) => Math.abs(a.vsFpm ?? 999) < 200 && (a.altFt ?? 0) > 5000,
  },
]

const toThousand = (ft: number) => Math.max(1000, Math.round(ft / 1000) * 1000)

export default function Page() {
  const [traffic, setTraffic] = useState<Aircraft[]>([])
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [query, setQuery] = useState('')
  const [issueError, setIssueError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [replay, setReplay] = useState<ReplayPosition | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [board, dispatch] = useReducer(boardReducer, initialBoardState)

  // ?replay=1 runs the whole app off the committed recording, no network.
  const isReplay = useMemo(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('replay') === '1'
  }, [])
  const replayStartedAt = useRef<number | null>(null)

  const poll = useCallback(async () => {
    try {
      let url = '/api/traffic'
      if (isReplay) {
        replayStartedAt.current ??= Date.now()
        url += `?replay=1&t=${Date.now() - replayStartedAt.current}`
      }
      const res = await fetch(url, { cache: 'no-store' })
      const body: TrafficResponse = await res.json()
      if (body.ok) {
        // Stamp arrival with THIS browser's clock. Staleness is judged from
        // `now - ts` and `now` is this browser's clock, so both sides of that
        // subtraction have to come from the same place.
        const receivedAt = Date.now()
        setTraffic(body.aircraft.map((a) => ({ ...a, ts: receivedAt })))
        setFetchedAt(body.fetchedAt)
        setReplay(body.replay ?? null)
        setError(null)
      } else {
        setError(body.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [isReplay])

  useEffect(() => {
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  // Every snapshot extends the track of each open clearance and re-judges it.
  useEffect(() => {
    if (traffic.length === 0) return
    dispatch({ type: 'SNAPSHOT', byHex: new Map(traffic.map((a) => [a.hex, a])), now: Date.now() })
  }, [traffic])

  const typed = query.trim()
  const resolution = useMemo(
    () => (typed ? resolveCallsign(typed, traffic) : null),
    [typed, traffic],
  )
  const parsed = useMemo(() => (typed ? parseInstruction(typed) : null), [typed])
  const suggestions = useMemo(
    () => (typed && resolution?.outcome === 'none' ? suggestSameAirline(typed, traffic) : []),
    [typed, resolution, traffic],
  )

  const issue = useCallback(
    (text: string, aircraft: Aircraft) => {
      const p = parseInstruction(text)
      if (!p.ok) {
        setIssueError(p.reason)
        return
      }
      const issuedAt = Date.now()
      dispatch({
        type: 'ISSUE',
        clearance: makeClearance({
          id: `${aircraft.hex}-${issuedAt}`,
          issuedAt,
          aircraft,
          constraint: p.constraint,
          spokenText: text,
          spokenCallsign: resolveCallsign(text, traffic).spokenCallsign,
        }),
      })
      setQuery('')
      setIssueError(null)
      inputRef.current?.focus()
    },
    [traffic],
  )

  /**
   * Try to issue whatever is in the box. Used by the button, by Enter, and by
   * voice once the speaker stops.
   *
   * Voice never forces a guess: an ambiguous callsign still stops and asks,
   * exactly as typing one does.
   */
  const submit = useCallback(
    (text: string) => {
      const t = text.trim()
      if (!t) return
      const r = resolveCallsign(t, traffic)
      const p = parseInstruction(t)
      if (!p.ok) {
        setIssueError(p.reason)
        return
      }
      if (r.outcome === 'exact') {
        issue(t, r.aircraft)
        return
      }
      setIssueError(
        r.outcome === 'ambiguous'
          ? 'More than one aircraft matches. Pick one below.'
          : `No aircraft matched. ${r.reason}`,
      )
    },
    [traffic, issue],
  )

  const applyPreset = useCallback(
    (preset: (typeof PRESETS)[number]) => {
      const candidates = traffic.filter(
        (a) => a.callsign && !a.onGround && a.seenPosSec < 5 && preset.pick(a),
      )
      if (candidates.length === 0) {
        setIssueError(`Nothing is currently doing that. Try another example.`)
        return
      }
      const a = candidates[0]
      const alt = a.altFt ?? 10000
      const target =
        preset.instruction === 'climb and maintain'
          ? toThousand(alt + 5000)
          : preset.instruction === 'descend and maintain'
            ? toThousand(alt - 4000)
            : toThousand(alt)
      setQuery(`${a.callsign} ${preset.instruction} ${target}`)
      setIssueError(null)
      inputRef.current?.focus()
    },
    [traffic],
  )

  const rows = useMemo(() => {
    const f = filter.trim().toUpperCase()
    return traffic
      .filter(
        (a) =>
          !f ||
          a.callsign?.includes(f) ||
          a.registration?.includes(f) ||
          a.type?.includes(f) ||
          a.hex.toUpperCase().includes(f),
      )
      .sort((a, b) => (a.callsign ?? 'zzzz').localeCompare(b.callsign ?? 'zzzz'))
  }, [traffic, filter])

  const watched = useMemo(() => new Set(board.clearances.map((c) => c.hex)), [board.clearances])
  const ageSec = fetchedAt === null ? null : Math.max(0, Math.round((now - fetchedAt) / 1000))
  const feedStale = ageSec !== null && ageSec > 10
  const status = error ? 'fault' : feedStale ? 'stale' : 'live'

  return (
    <main className="mx-auto max-w-[1440px] px-6 pb-20">
      {/* Nameplate. Equipment is labelled, not branded. */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule py-5">
        <div>
          <h1 className="text-[15px] font-bold tracking-[0.16em] uppercase text-ink">
            Clearance Conformance Monitor
          </h1>
          <p className="mt-1.5 font-mono text-xs text-ink-faint">
            KSFO · 40 nm · headings magnetic, var {TOL.magVarDeg}°E
          </p>
        </div>

        <div className="flex items-center gap-5 font-mono text-xs tnum">
          {isReplay && (
            <span className="border border-holder-unknown px-2 py-1 text-holder-unknown uppercase tracking-wider">
              Replay {replay ? `${replay.frame + 1}/${replay.frames}` : ''}
            </span>
          )}
          <span className="flex items-center gap-2 text-ink-dim">
            <span
              className={
                'inline-block h-1.5 w-1.5 rounded-full ' +
                (status === 'live'
                  ? 'bg-signal-live'
                  : status === 'stale'
                    ? 'bg-signal-stale'
                    : 'bg-signal-fault')
              }
              aria-hidden
            />
            {status === 'fault' ? 'holding last' : status === 'stale' ? `stale ${ageSec}s` : `live ${ageSec ?? '—'}s`}
          </span>
          <span className="text-ink-faint">{traffic.length} contacts</span>
        </div>
      </header>

      {/* The disclosure that has to come first. */}
      <p className="border-b border-rule py-3 text-xs leading-relaxed text-ink-dim">
        <span className="label mr-2 text-signal-stale">Synthetic</span>
        Clearances issued here are never transmitted and no aircraft receives them. The aircraft,
        the ADS-B tracks and the conformance logic are real. Compliance means the aircraft happened
        to already be doing it. Output is a candidate for review, not a finding.
        {isReplay && replay && (
          <span className="ml-1 text-holder-unknown">
            Replay: recorded tracks from {new Date(replay.recordedAt).toLocaleString()}, not live
            traffic.
          </span>
        )}
      </p>

      {/* Command line. */}
      <section className="py-6">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit(query)
          }}
          className="flex flex-wrap gap-2"
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIssueError(null)
            }}
            placeholder="united 328 climb and maintain flight level 350"
            aria-label="Clearance"
            className="min-w-[300px] flex-1 border border-rule-bright bg-bay-sunk px-3 py-2.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-ink-dim focus:outline-none"
          />
          <button
            type="submit"
            className="border border-ink-dim bg-ink px-6 py-2.5 font-mono text-xs tracking-wide uppercase text-bay hover:bg-white"
          >
            Issue
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <PushToTalk
            onTranscript={(text, autoIssue) => {
              setQuery(text)
              setIssueError(null)
              if (autoIssue) submit(text)
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">examples</span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className="border border-rule px-2.5 py-1 font-mono text-[11px] text-ink-faint hover:border-ink-faint hover:text-ink-dim"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* What would be issued, as it is typed. */}
        {typed && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-l-2 border-rule-bright bg-bay-raised px-4 py-3 font-mono text-xs">
            <span className="flex items-center gap-2">
              <span className="label">aircraft</span>
              {resolution?.outcome === 'exact' ? (
                <span className="text-ink">
                  {resolution.resolvedCallsign} · {resolution.aircraft.registration ?? '—'} ·{' '}
                  {resolution.aircraft.type ?? '—'} ·{' '}
                  {resolution.aircraft.altFt != null
                    ? formatAltitude(resolution.aircraft.altFt)
                    : 'ground'}
                </span>
              ) : (
                <span className="text-ink-faint">
                  {resolution?.outcome === 'ambiguous'
                    ? `${resolution.candidates.length} candidates — pick one`
                    : (resolution?.reason ?? 'no callsign yet')}
                </span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <span className="label">clearance</span>
              <span className={parsed?.ok ? 'text-ink' : 'text-ink-faint'}>
                {parsed?.ok ? describeConstraint(parsed.constraint) : (parsed?.reason ?? '—')}
              </span>
            </span>
          </div>
        )}

        {issueError && <p className="mt-2 text-xs text-signal-stale">{issueError}</p>}

        {/* Ambiguity is resolved by the operator, never by the app — including
            when the clearance arrived by voice. */}
        {resolution?.outcome === 'ambiguous' && (
          <div className="mt-2 flex flex-col gap-px bg-rule">
            {resolution.candidates.map((c) => (
              <button
                key={c.hex}
                onClick={() => issue(typed, c)}
                className="bg-bay-raised px-4 py-2.5 text-left font-mono text-xs text-ink hover:bg-rule"
              >
                {c.callsign} · {c.hex} · {c.registration ?? '—'} · {c.type ?? '—'} ·{' '}
                {c.altFt != null ? formatAltitude(c.altFt) : 'ground'}
              </button>
            ))}
          </div>
        )}

        {suggestions.length > 0 && (
          <p className="mt-2 font-mono text-xs text-ink-faint">
            same operator airborne now: {suggestions.map((a) => a.callsign).join('  ')}
          </p>
        )}
      </section>

      {/* The bay. */}
      <section>
        <div className="mb-3 flex items-baseline justify-between border-b border-rule pb-2">
          <h2 className="label text-ink-dim">Strip bay</h2>
          <span className="font-mono text-[11px] text-ink-faint tnum">
            {board.clearances.length} strips · response window {TOL.responseWindowSec}s · level band{' '}
            ±{TOL.altLevelBandFt} ft · heading ±{TOL.hdgToleranceDeg}°
          </span>
        </div>
        <StripBay clearances={board.clearances} now={now} />
      </section>

      {/* The traffic being watched. Quiet by design: the strips are the subject. */}
      <section className="mt-12">
        <div className="mb-3 flex items-baseline justify-between border-b border-rule pb-2">
          <h2 className="label text-ink-dim">Traffic</h2>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter"
            aria-label="Filter traffic"
            className="w-36 border border-rule bg-bay-sunk px-2 py-1 font-mono text-[11px] text-ink-dim placeholder:text-ink-faint focus:border-rule-bright focus:outline-none"
          />
        </div>

        <div className="max-h-[380px] overflow-auto">
          <table className="w-full border-collapse font-mono text-xs tnum">
            <thead className="sticky top-0 bg-bay">
              <tr className="border-b border-rule text-left">
                <Th>callsign</Th>
                <Th>tail</Th>
                <Th>type</Th>
                <Th right>alt</Th>
                <Th right>vs</Th>
                <Th right>gs</Th>
                <Th right>trk°T</Th>
                <Th right>hdg</Th>
                <Th right>age</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const stale = a.seenPosSec > TOL.staleTrackSec
                const onStrip = watched.has(a.hex)
                return (
                  <tr
                    key={a.hex}
                    className={
                      'border-b border-rule/40 ' +
                      (onStrip ? 'bg-bay-raised text-ink' : stale ? 'text-ink-faint' : 'text-ink-dim')
                    }
                  >
                    <Td className={onStrip ? 'text-ink' : 'text-ink'}>
                      {onStrip && <span className="mr-1.5 text-holder-complying">▌</span>}
                      {a.callsign ?? '—'}
                    </Td>
                    <Td>{a.registration ?? '—'}</Td>
                    <Td>{a.type ?? '—'}</Td>
                    <Td right>{a.onGround ? 'GND' : a.altFt != null ? altitudeTag(a.altFt) : '—'}</Td>
                    <Td right>{a.vsFpm != null ? formatVerticalRate(a.vsFpm) : '—'}</Td>
                    <Td right>{a.gsKt != null ? Math.round(a.gsKt) : '—'}</Td>
                    <Td right>{a.trackTrue != null ? formatHeading(a.trackTrue) : '—'}</Td>
                    <Td right>{a.navHeading != null ? formatHeading(a.navHeading) : '—'}</Td>
                    <Td right className={stale ? 'text-signal-stale' : ''}>
                      {Number.isFinite(a.seenPosSec) ? a.seenPosSec.toFixed(0) : '—'}
                    </Td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-ink-faint">
                    {traffic.length === 0 ? 'waiting for first snapshot' : 'nothing matches'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 max-w-3xl text-xs leading-relaxed text-ink-faint">
          Altitude is shown in hundreds of feet, the way a radar data block shows it. Track is
          degrees true; headings are judged in degrees magnetic, corrected {TOL.magVarDeg}° for
          variation at SFO. Ground track is not heading — wind pushes the aircraft sideways — so the
          autopilot&rsquo;s selected heading is preferred where it is broadcast. Tracks older than{' '}
          {TOL.staleTrackSec}s are judged UNKNOWN, never DEVIATED.
        </p>
      </section>
    </main>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`label px-2 py-2 font-semibold ${right ? 'text-right' : 'text-left'}`}>{children}</th>
  )
}

function Td({
  children,
  right,
  className = '',
}: {
  children: React.ReactNode
  right?: boolean
  className?: string
}) {
  return <td className={`px-2 py-1.5 ${right ? 'text-right ' : ''}${className}`}>{children}</td>
}
