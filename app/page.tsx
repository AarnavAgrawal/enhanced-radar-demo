'use client'

// Phases 1 to 3: live traffic near SFO, callsign resolution, and the clearance
// parsed into a constraint. No verdict yet -- the conformance engine is phase 4.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Aircraft, TrafficResponse } from '@/lib/types'
import { resolveCallsign, suggestSameAirline } from '@/lib/callsign'
import { parseInstruction, describeConstraint } from '@/lib/parser'

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
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

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

  // Separate ticker so the "age" readout counts up between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  // Re-resolve on every snapshot, so the resolved aircraft's numbers stay live
  // rather than freezing at the moment the operator pressed enter.
  const resolution = useMemo(
    () => (submitted ? resolveCallsign(submitted, traffic) : null),
    [submitted, traffic],
  )
  const suggestions = useMemo(
    () => (submitted && resolution?.outcome === 'none' ? suggestSameAirline(submitted, traffic) : []),
    [submitted, resolution, traffic],
  )
  // Phase 3. The parse depends only on the text, never on the traffic picture,
  // so it does not need to be redone on every snapshot.
  const parsed = useMemo(() => (submitted ? parseInstruction(submitted) : null), [submitted])

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

  const ageSec = fetchedAt === null ? null : Math.max(0, Math.round((now - fetchedAt) / 1000))
  const feedStale = ageSec !== null && ageSec > 10

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-6">
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
              {error ? 'FEED ERROR · HOLDING LAST' : feedStale ? `STALE ${ageSec}s` : `LIVE ${ageSec ?? '--'}s`}
            </span>
            <span className="text-slate-500">{traffic.length} contacts</span>
          </div>
        </div>
        {/* Section 1 of CLAUDE.md: this disclosure goes first, not buried. */}
        <p className="mt-3 text-sm text-amber-300/90">
          Clearances typed here are synthetic. No aircraft ever receives them. The aircraft, the
          ADS-B tracks and the conformance logic are real; the instruction is not transmitted.
        </p>
        {error && (
          <p className="mt-2 font-mono text-xs text-amber-500/80">
            last fetch failed: {error} — showing last known picture
          </p>
        )}
      </header>

      {/* ---- Phase 2: callsign resolution ---- */}
      <section className="mt-6">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setSubmitted(query.trim() || null)
          }}
          className="flex flex-wrap gap-2"
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="united 328 climb and maintain one zero thousand"
            className="min-w-[320px] flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-600"
          />
          <button
            type="submit"
            className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600"
          >
            Resolve
          </button>
          {submitted && (
            <button
              type="button"
              onClick={() => {
                setSubmitted(null)
                setQuery('')
                inputRef.current?.focus()
              }}
              className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-400 hover:bg-slate-900"
            >
              Clear
            </button>
          )}
        </form>

        {resolution && (
          <div className="mt-3 rounded border border-slate-800 bg-slate-900/50 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={
                  'rounded px-2 py-1 font-mono text-xs font-semibold ' +
                  (resolution.outcome === 'exact'
                    ? 'bg-emerald-950 text-emerald-400'
                    : resolution.outcome === 'ambiguous'
                      ? 'bg-amber-950 text-amber-400'
                      : 'bg-slate-800 text-slate-400')
                }
              >
                {resolution.outcome.toUpperCase()}
              </span>
              <span className="font-mono text-sm text-slate-400">
                &ldquo;{resolution.spokenCallsign}&rdquo;
                {resolution.resolvedCallsign && (
                  <>
                    <span className="mx-2 text-slate-600">→</span>
                    <span className="text-slate-100">{resolution.resolvedCallsign}</span>
                  </>
                )}
              </span>
            </div>

            {resolution.outcome === 'exact' && (
              <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 font-mono text-sm sm:grid-cols-4 lg:grid-cols-7">
                <Field label="hex" value={resolution.aircraft.hex} accent />
                <Field label="tail" value={resolution.aircraft.registration ?? '--'} accent />
                <Field label="type" value={resolution.aircraft.type ?? '--'} />
                <Field label="altitude" value={`${fmtAlt(resolution.aircraft)} ft`} />
                <Field label="vertical" value={`${fmtVs(resolution.aircraft.vsFpm)} fpm`} />
                <Field label="gnd speed" value={`${Math.round(resolution.aircraft.gsKt ?? 0)} kt`} />
                <Field
                  label="track (true)"
                  value={
                    resolution.aircraft.trackTrue === null
                      ? '--'
                      : `${Math.round(resolution.aircraft.trackTrue).toString().padStart(3, '0')}°`
                  }
                />
              </dl>
            )}

            {resolution.outcome === 'ambiguous' && (
              <div className="mt-3">
                <p className="text-sm text-amber-300/90">
                  {resolution.candidates.length} live aircraft match. Not guessing — pick one.
                </p>
                <ul className="mt-2 space-y-1 font-mono text-sm">
                  {resolution.candidates.map((c) => (
                    <li key={c.hex} className="text-slate-300">
                      {c.callsign} · {c.hex} · {c.registration ?? '--'} · {c.type ?? '--'} ·{' '}
                      {fmtAlt(c)} ft
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {resolution.outcome === 'none' && (
              <>
                <p className="mt-3 text-sm text-slate-400">{resolution.reason}</p>
                {suggestions.length > 0 && (
                  <p className="mt-2 font-mono text-sm text-slate-500">
                    same operator airborne now: {suggestions.map((a) => a.callsign).join(' · ')}
                  </p>
                )}
              </>
            )}

            {/* Phase 3: the instruction, parsed by grammar into a constraint. */}
            {parsed && (
              <div className="mt-4 border-t border-slate-800 pt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={
                      'rounded px-2 py-1 font-mono text-xs font-semibold ' +
                      (parsed.ok ? 'bg-emerald-950 text-emerald-400' : 'bg-slate-800 text-slate-400')
                    }
                  >
                    {parsed.ok ? 'PARSED' : 'NOT PARSED'}
                  </span>
                  {parsed.ok ? (
                    <>
                      <span className="text-sm text-slate-100">
                        {describeConstraint(parsed.constraint)}
                      </span>
                      <span className="font-mono text-xs text-slate-500">
                        form: {parsed.form}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-slate-400">{parsed.reason}</span>
                  )}
                </div>
                {parsed.ok && (
                  <pre className="mt-3 overflow-x-auto rounded bg-slate-950 p-3 font-mono text-xs text-sky-300">
{JSON.stringify(parsed.constraint, null, 2)}
                  </pre>
                )}
                <p className="mt-2 text-xs text-slate-600">
                  Parsed only. No conformance verdict yet — the engine is phase 4.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ---- Phase 1: live traffic ---- */}
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
        <div className="overflow-x-auto rounded border border-slate-800">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
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
                const highlight =
                  resolution?.outcome === 'exact' && resolution.aircraft.hex === a.hex
                return (
                  <tr
                    key={a.hex}
                    className={
                      'border-t border-slate-900 ' +
                      (highlight ? 'bg-sky-950/60' : stale ? 'text-slate-600' : 'hover:bg-slate-900/50')
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
                    {traffic.length === 0 ? 'waiting for first snapshot…' : 'no contacts match filter'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          Track is degrees true and is not heading — wind pushes the aircraft sideways. Magnetic
          correction and heading conformance arrive with the engine in phase 4. Rows dimmed and
          flagged amber have not reported a position for more than {STALE_SEC}s.
        </p>
      </section>
    </main>
  )
}

function Field({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={accent ? 'mt-1 text-sky-300' : 'mt-1 text-slate-100'}>{value}</dd>
    </div>
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
