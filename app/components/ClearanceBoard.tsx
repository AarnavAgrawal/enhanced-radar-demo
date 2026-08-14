// The board. One row per clearance issued this session, closed ones included.

import type { Clearance, Verdict } from '@/lib/types'
import { describeConstraint } from '@/lib/parser'
import { TOL } from '@/lib/conform'
import { trendSeries } from '@/lib/board'
import { Sparkline } from './Sparkline'

const VERDICT_STYLE: Record<Verdict, string> = {
  PENDING: 'bg-slate-800 text-slate-300',
  COMPLYING: 'bg-amber-950 text-amber-400',
  COMPLIED: 'bg-emerald-950 text-emerald-400',
  DEVIATED: 'bg-red-950 text-red-400',
  SUPERSEDED: 'bg-slate-800/60 text-slate-500',
  UNKNOWN: 'bg-slate-800 text-slate-400',
}

const VERDICT_TONE: Record<Verdict, 'pending' | 'complying' | 'complied' | 'deviated' | 'closed'> = {
  PENDING: 'pending',
  COMPLYING: 'complying',
  COMPLIED: 'complied',
  DEVIATED: 'deviated',
  SUPERSEDED: 'closed',
  UNKNOWN: 'closed',
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span className={`rounded px-2 py-1 font-mono text-xs font-semibold ${VERDICT_STYLE[verdict]}`}>
      {verdict}
    </span>
  )
}

function fmtAlt(v: number | null): string {
  return v === null ? '--' : `${Math.round(v).toLocaleString('en-US')} ft`
}

function fmtVs(v: number | null): string {
  if (v === null) return '--'
  if (Math.abs(v) < TOL.vsLevelFpm) return 'level'
  return `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')} fpm`
}

export function ClearanceBoard({ clearances, now }: { clearances: Clearance[]; now: number }) {
  if (clearances.length === 0) {
    return (
      <div className="rounded border border-dashed border-slate-800 p-8 text-center text-sm text-slate-600">
        No clearances issued yet. Type one above at an aircraft from the list below.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded border border-slate-800">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-500">
            <th className="px-3 py-2 font-medium">spoken</th>
            <th className="px-3 py-2 font-medium">callsign</th>
            <th className="px-3 py-2 font-medium">tail</th>
            <th className="px-3 py-2 font-medium">type</th>
            <th className="px-3 py-2 text-right font-medium">now</th>
            <th className="px-3 py-2 font-medium">clearance</th>
            <th className="px-3 py-2 font-medium">trend</th>
            <th className="px-3 py-2 font-medium">verdict</th>
          </tr>
        </thead>
        <tbody>
          {clearances.map((c) => (
            <ClearanceRow key={c.id} clearance={c} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ClearanceRow({ clearance: c, now }: { clearance: Clearance; now: number }) {
  const latest = c.history[c.history.length - 1] ?? null
  const trend = trendSeries(c)
  const closed = c.status === 'SUPERSEDED'
  // The 20 s response window is shown counting down rather than left implied,
  // so nobody has to guess whether the engine is still waiting or has given up.
  const secondsLeft = Math.max(0, Math.ceil(TOL.responseWindowSec - (now - c.issuedAt) / 1000))

  return (
    <>
      <tr className={`border-t border-slate-800 ${closed ? 'opacity-50' : ''}`}>
        <td className="px-3 py-2 font-mono text-slate-400">{c.spokenCallsign}</td>
        <td className="px-3 py-2 font-mono font-semibold text-slate-100">{c.resolvedCallsign}</td>
        <td className="px-3 py-2 font-mono text-slate-300">{c.registration ?? '--'}</td>
        <td className="px-3 py-2 font-mono text-slate-400">
          {/* Type is not on the clearance; it is shown from the traffic table. */}
          <span className="text-slate-500">{c.hex}</span>
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-300">
          {fmtAlt(latest?.altFt ?? null)}
          <span className="ml-2 text-slate-500">{fmtVs(latest?.vsFpm ?? null)}</span>
        </td>
        <td className="px-3 py-2 text-slate-200">{describeConstraint(c.constraint)}</td>
        <td className="px-3 py-2">
          {trend ? (
            <Sparkline values={trend.values} target={trend.target} tone={VERDICT_TONE[c.status]} />
          ) : (
            <span className="font-mono text-xs text-slate-600">no data</span>
          )}
        </td>
        <td className="whitespace-nowrap px-3 py-2">
          <VerdictBadge verdict={c.status} />
          {c.status === 'PENDING' && (
            <span className="ml-2 font-mono text-xs text-slate-500">{secondsLeft}s</span>
          )}
        </td>
      </tr>
      <tr className={`border-slate-900 ${closed ? 'opacity-50' : ''}`}>
        <td colSpan={8} className="px-3 pb-3 text-xs text-slate-400">
          <span className="text-slate-600">evidence: </span>
          {c.detail}
        </td>
      </tr>
    </>
  )
}
