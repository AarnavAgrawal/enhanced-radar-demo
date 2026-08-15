// One clearance, rendered as a flight progress strip.
//
// Controllers work paper strips racked in a bay. The strip carries the aircraft
// on the left, the clearance in the middle, and the controller's annotation
// underneath. When an instruction is amended they do not erase the old one,
// they cross it out and write the new one on a fresh strip -- which is exactly
// what SUPERSEDED means, and why a struck-through strip reads as amended rather
// than failed without anyone having to explain it.

import type { Clearance, Verdict } from '@/lib/types'
import { describeConstraint } from '@/lib/parser'
import { TOL } from '@/lib/conform'
import { trendSeries } from '@/lib/board'
import { formatAltitude, formatAltitudeShort, formatHeading, formatVerticalRate } from '@/lib/format'
import { Sparkline } from './Sparkline'

const PAPER: Record<Verdict, string> = {
  PENDING: 'bg-strip-pending',
  COMPLYING: 'bg-strip-complying',
  COMPLIED: 'bg-strip-complied',
  DEVIATED: 'bg-strip-deviated',
  SUPERSEDED: 'bg-strip-superseded',
  UNKNOWN: 'bg-strip-unknown',
}

const HOLDER: Record<Verdict, string> = {
  PENDING: 'bg-holder-pending',
  COMPLYING: 'bg-holder-complying',
  COMPLIED: 'bg-holder-complied',
  DEVIATED: 'bg-holder-deviated',
  SUPERSEDED: 'bg-holder-superseded',
  UNKNOWN: 'bg-holder-unknown',
}

/**
 * The clearance in strip shorthand.
 *
 * A real strip writes altitude in hundreds of feet, which is unambiguous on
 * paper in a tower but not on a screen next to a live readout: "096" read as a
 * flight level says FL096, and no such level exists. So the altitude keeps its
 * unit, and only the direction is abbreviated.
 */
function shorthand(c: Clearance['constraint']): string {
  switch (c.kind) {
    case 'ALTITUDE': {
      const mark = c.direction === 'up' ? '↑' : c.direction === 'down' ? '↓' : '='
      return `${mark} ${formatAltitudeShort(c.targetFt)}`
    }
    case 'HEADING': {
      const mark = c.turn === 'left' ? 'L' : c.turn === 'right' ? 'R' : 'H'
      return `${mark}${formatHeading(c.targetDegMag)}`
    }
    case 'SPEED':
      return `${c.targetKt} kt`
  }
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`border-strip-ink-dim/25 px-3 py-2 ${className}`}>
      <div className="label label-on-paper mb-1.5">{label}</div>
      {children}
    </div>
  )
}

export function ClearanceStrip({ clearance: c, now }: { clearance: Clearance; now: number }) {
  const latest = c.history[c.history.length - 1] ?? null
  const trend = trendSeries(c)
  const amended = c.status === 'SUPERSEDED'
  const secondsLeft = Math.max(0, Math.ceil(TOL.responseWindowSec - (now - c.issuedAt) / 1000))

  return (
    <article className={`flex ${amended ? 'opacity-70' : ''}`}>
      {/* The plastic holder the strip sits in. */}
      <div className={`w-1.5 shrink-0 ${HOLDER[c.status]}`} aria-hidden />

      <div className={`flex-1 ${PAPER[c.status]} text-strip-ink`}>
        <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] max-lg:grid-cols-2">
          <Field label="aircraft">
            <div className="font-mono text-base leading-none font-semibold tracking-tight">
              {c.resolvedCallsign}
            </div>
            <div className="mt-1.5 font-mono text-xs text-strip-ink-dim">
              {c.registration ?? '---'} · {c.hex}
            </div>
          </Field>

          <Field label="clearance" className={`border-l ${amended ? 'struck' : ''}`}>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-base leading-none font-semibold tnum">
                {shorthand(c.constraint)}
              </span>
              {c.amendedFrom && (
                <span className="font-mono text-[10px] text-strip-ink-dim line-through">
                  {shorthand(c.amendedFrom)}
                </span>
              )}
            </div>
            <div className="mt-1.5 text-xs text-strip-ink-dim">
              {describeConstraint(c.constraint)}
              {c.amendedFrom && <span className="ml-1 uppercase">(amended)</span>}
            </div>
          </Field>

          <Field label="now" className="border-l">
            <div className="font-mono text-base leading-none tnum">
              {latest?.altFt != null ? formatAltitude(latest.altFt) : '---'}
            </div>
            <div className="mt-1.5 font-mono text-xs text-strip-ink-dim tnum">
              {latest?.vsFpm != null ? `${formatVerticalRate(latest.vsFpm)} fpm` : '---'}
              {latest?.gsKt != null && ` · ${Math.round(latest.gsKt)} kt`}
            </div>
          </Field>

          <Field label="trend" className="border-l max-lg:hidden">
            {trend ? (
              <Sparkline values={trend.values} target={trend.target} verdict={c.status} />
            ) : (
              <span className="font-mono text-xs text-strip-ink-dim">no data</span>
            )}
          </Field>

          <Field label="verdict" className="border-l">
            <div className="flex items-baseline gap-2 whitespace-nowrap">
              <span className="font-mono text-base leading-none font-semibold tracking-tight">
                {c.status}
              </span>
              {c.status === 'PENDING' && (
                <span className="font-mono text-xs text-strip-ink-dim tnum">{secondsLeft}s</span>
              )}
            </div>
            <div className="mt-1.5 font-mono text-xs text-strip-ink-dim">
              {new Date(c.issuedAt).toLocaleTimeString('en-GB', { hour12: false })}
            </div>
          </Field>
        </div>

        {/* The annotation band: what the controller would write underneath. */}
        <div className="border-t border-strip-ink-dim/25 px-3 py-2">
          <p className="text-xs leading-relaxed text-strip-ink/80">
            <span className="label label-on-paper mr-2">evidence</span>
            {c.detail}
          </p>
          {c.spokenText && (
            <p className="mt-1 font-mono text-[11px] text-strip-ink-dim">
              &ldquo;{c.spokenText}&rdquo;
            </p>
          )}
        </div>
      </div>
    </article>
  )
}

export function StripBay({ clearances, now }: { clearances: Clearance[]; now: number }) {
  if (clearances.length === 0) {
    return (
      <div className="border border-dashed border-rule px-6 py-12 text-center">
        <p className="text-sm text-ink-dim">No strips in the bay.</p>
        <p className="mt-1 text-sm text-ink-faint">
          Issue a clearance above to start one, or press Talk and say it.
        </p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-px bg-rule">
      {clearances.map((c) => (
        <ClearanceStrip key={c.id} clearance={c} now={now} />
      ))}
    </div>
  )
}
