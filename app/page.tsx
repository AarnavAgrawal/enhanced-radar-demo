'use client'

// Phases 1 to 5. Live traffic near SFO, callsign resolution, clearance parsing,
// the conformance engine, and the board that shows what it concluded.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Aircraft, TrafficResponse } from '@/lib/types'
import { resolveCallsign, suggestSameAirline } from '@/lib/callsign'
import { parseInstruction, describeConstraint } from '@/lib/parser'
import { TOL } from '@/lib/conform'
import { boardReducer, initialBoardState, makeClearance } from '@/lib/board'
import { ClearanceBoard } from './components/ClearanceBoard'

const POLL_MS = 2000
/** Beyond this many seconds since the last position, a track is not trustworthy. */
const STALE_SEC = 15

function fmtAlt(a: Aircraft): string {
  if (a.onGround) return 'ground'
  return a.altFt === null ? '--' : a.altFt.toLocaleString('en-US')
}

function fmtVs(vs: number | null): string {
  if (vs === null) return '--'
  const r = Math.round(vs / 10) * 10
  if (Math.abs(r) < 100) return 'level'
  return `${r > 0 ? '+' : ''}${r.toLocaleString('en-US')}`
}

function vsClass(vs: number | null): string {
  if (vs === null || Math.abs(vs) < 100) return 'text-slate-400'
  return vs > 0 ? 'text-emerald-400' : 'text-sky-400'
}

export default function Page() {
  const [traffic, setTraffic] = useState<Aircraft[]>([])
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [source, setSource] = useState<string>('--')
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [query, setQuery] = useState('')
  const [issueError, setIssueError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [board, dispatch] = useReducer(boardReducer, initialBoardState)

  // Poll the proxy. A failed poll keeps the previous picture on screen and
  // raises the stale badge instead of blanking the board.
  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/traffic', { cache: 'no-store' })
      const body: TrafficResponse = await res.json()
      if (body.ok) {
        setTraffic(body.aircraft)
        setFetchedAt(body.fetchedAt)
        setSource(body.source)
        setError(null)
      } else {
        setError(body.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  // Ticker, so the response countdown and the feed age move between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  // Every snapshot extends the track of each open clearance and re-judges it.
  useEffect(() => {
    if (traffic.length === 0) return
    dispatch({ type: 'SNAPSHOT', byHex: new Map(traffic.map((a) => [a.hex, a])), now: Date.now() })
  }, [traffic])

  // Live preview of what would be issued, so a bad callsign or an unparseable
  // instruction shows before enter is pressed rather than after.
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

  const submit = useCallback(() => {
    if (!typed) return
    const r = resolveCallsign(typed, traffic)
    const p = parseInstruction(typed)
    if (!p.ok) {
      setIssueError(p.reason)
      return
    }
    if (r.outcome === 'exact') {
      issue(typed, r.aircraft)
      return
    }
    setIssueError(
      r.outcome === 'ambiguous'
        ? 'more than one aircraft matches, pick one below'
        : `could not resolve an aircraft: ${r.reason}`,
    )
  }, [typed, traffic, issue])

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

  return (
    <main className="mx-auto max-w-[1500px] px-6 py-6">
      <header className="border-b border-slate-800 pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">
            Clearance Conformance Monitor
            <span className="ml-3 font-mono text-sm font-normal text-slate-500">SFO · 40 nm</span>
          </h1>
          <div className="flex items-center gap-3 font-mono text-xs">
            <span className="text-slate-500">{source}</span>
            <span
              className={
                error || feedStale
                  ? 'rounded bg-amber-950 px-2 py-1 text-amber-400'
                  : 'rounded bg-emerald-950 px-2 py-1 text-emerald-400'
              }
            >
              {error
                ? 'FEED ERROR · HOLDING LAST'
                : feedStale
                  ? `STALE ${ageSec}s`
                  : `LIVE ${ageSec ?? '--'}s`}
            </span>
            <span className="text-slate-500">{traffic.length} contacts</span>
          </div>
        </div>
        {/* Section 1 of CLAUDE.md: this disclosure goes first, not buried. */}
        <p className="mt-3 text-sm text-amber-300/90">
          Clearances typed here are synthetic. No aircraft ever receives them. The aircraft, the
          ADS-B tracks and the conformance logic are real; the instruction is not transmitted.
          Compliance means the aircraft happened to already be doing that. The output is a
          candidate for review, not a finding.
        </p>
        {error && (
          <p className="mt-2 font-mono text-xs text-amber-500/80">
            last fetch failed: {error} — showing last known picture
          </p>
        )}
      </header>

      {/* ---- issue a clearance ---- */}
      <section className="mt-6">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
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
            placeholder="united 328 climb and maintain one zero thousand"
            className="min-w-[320px] flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-600"
          />
          <button
            type="submit"
            className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600"
          >
            Issue
          </button>
        </form>

        {/* What would be issued, updated as it is typed. */}
        {typed && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded border border-slate-800 bg-slate-900/50 px-4 py-3 font-mono text-xs">
            <span
              className={
                'rounded px-2 py-1 font-semibold ' +
                (resolution?.outcome === 'exact'
                  ? 'bg-emerald-950 text-emerald-400'
                  : resolution?.outcome === 'ambiguous'
                    ? 'bg-amber-950 text-amber-400'
                    : 'bg-slate-800 text-slate-400')
              }
            >
              {resolution?.outcome.toUpperCase() ?? 'NONE'}
            </span>
            {resolution?.outcome === 'exact' ? (
              <span className="text-slate-300">
                {resolution.resolvedCallsign} · {resolution.aircraft.hex} ·{' '}
                {resolution.aircraft.registration ?? '--'} · {resolution.aircraft.type ?? '--'} ·{' '}
                {fmtAlt(resolution.aircraft)} ft
              </span>
            ) : (
              <span className="text-slate-500">
                {resolution?.outcome === 'ambiguous'
                  ? `${resolution.candidates.length} candidates`
                  : (resolution?.reason ?? '')}
              </span>
            )}
            <span className="text-slate-700">|</span>
            <span
              className={
                'rounded px-2 py-1 font-semibold ' +
                (parsed?.ok ? 'bg-emerald-950 text-emerald-400' : 'bg-slate-800 text-slate-400')
              }
            >
              {parsed?.ok ? 'PARSED' : 'NOT PARSED'}
            </span>
            <span className="text-slate-300">
              {parsed?.ok ? describeConstraint(parsed.constraint) : (parsed?.reason ?? '')}
            </span>
          </div>
        )}

        {issueError && <p className="mt-2 text-sm text-amber-400">{issueError}</p>}

        {/* Ambiguity is resolved by the operator, never by the app. */}
        {resolution?.outcome === 'ambiguous' && (
          <div className="mt-2 space-y-1">
            {resolution.candidates.map((c) => (
              <button
                key={c.hex}
                onClick={() => issue(typed, c)}
                className="block w-full rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-left font-mono text-sm text-amber-200 hover:bg-amber-950/50"
              >
                {c.callsign} · {c.hex} · {c.registration ?? '--'} · {c.type ?? '--'} · {fmtAlt(c)} ft
              </button>
            ))}
          </div>
        )}

        {suggestions.length > 0 && (
          <p className="mt-2 font-mono text-xs text-slate-500">
            same operator airborne now: {suggestions.map((a) => a.callsign).join(' · ')}
          </p>
        )}
      </section>

      {/* ---- the board ---- */}
      <section className="mt-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            Clearances this session
          </h2>
          <span className="font-mono text-xs text-slate-600">
            {board.clearances.length} issued · response window {TOL.responseWindowSec}s · level band{' '}
            {TOL.altLevelBandFt} ft · heading tolerance {TOL.hdgToleranceDeg}°
          </span>
        </div>
        <ClearanceBoard clearances={board.clearances} now={now} />
      </section>

      {/* ---- live traffic ---- */}
      <section className="mt-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            Live traffic
          </h2>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter"
            className="w-40 rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-300 outline-none placeholder:text-slate-600 focus:border-slate-600"
          />
        </div>
        <div className="max-h-[420px] overflow-auto rounded border border-slate-800">
          <table className="w-full border-collapse font-mono text-sm">
            <thead className="sticky top-0">
              <tr className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-500">
                <Th>callsign</Th>
                <Th>hex</Th>
                <Th>tail</Th>
                <Th>type</Th>
                <Th right>alt ft</Th>
                <Th right>vs fpm</Th>
                <Th right>gs kt</Th>
                <Th right>trk °T</Th>
                <Th right>nav hdg</Th>
                <Th right>age s</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const stale = a.seenPosSec > STALE_SEC
                return (
                  <tr
                    key={a.hex}
                    className={
                      'border-t border-slate-900 ' +
                      (watched.has(a.hex)
                        ? 'bg-sky-950/50'
                        : stale
                          ? 'text-slate-600'
                          : 'hover:bg-slate-900/50')
                    }
                  >
                    <Td className="font-semibold text-slate-100">{a.callsign ?? '--'}</Td>
                    <Td className="text-slate-500">{a.hex}</Td>
                    <Td>{a.registration ?? '--'}</Td>
                    <Td className="text-slate-400">{a.type ?? '--'}</Td>
                    <Td right>{fmtAlt(a)}</Td>
                    <Td right className={stale ? '' : vsClass(a.vsFpm)}>
                      {fmtVs(a.vsFpm)}
                    </Td>
                    <Td right>{a.gsKt === null ? '--' : Math.round(a.gsKt)}</Td>
                    <Td right>
                      {a.trackTrue === null
                        ? '--'
                        : Math.round(a.trackTrue).toString().padStart(3, '0')}
                    </Td>
                    <Td right className="text-slate-500">
                      {a.navHeading === null
                        ? '--'
                        : Math.round(a.navHeading).toString().padStart(3, '0')}
                    </Td>
                    <Td right className={stale ? 'text-amber-600' : 'text-slate-600'}>
                      {Number.isFinite(a.seenPosSec) ? a.seenPosSec.toFixed(1) : '--'}
                    </Td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-6 text-center text-slate-600">
                    {traffic.length === 0
                      ? 'waiting for first snapshot…'
                      : 'no contacts match filter'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          Track is degrees true; headings are judged in degrees magnetic, corrected by{' '}
          {TOL.magVarDeg}° for variation at SFO. Ground track is not heading, because wind pushes
          the aircraft sideways, so <span className="font-mono">nav hdg</span> is preferred when the
          autopilot broadcasts it. Rows flagged amber have not reported a position for more than{' '}
          {STALE_SEC}s and are judged UNKNOWN, never DEVIATED.
        </p>
      </section>
    </main>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={'px-3 py-2 font-medium ' + (right ? 'text-right' : '')}>{children}</th>
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
  return <td className={'px-3 py-1.5 ' + (right ? 'text-right ' : '') + className}>{children}</td>
}
