'use client'

// A plan view of the traffic, in a window you can drag out of the way.
//
// Drawn from lat/lon rather than fetched as map tiles. That is not a shortcut:
// a tile layer would need the network, which is exactly what replay mode exists
// to survive, and a controller's plan view has no satellite imagery on it
// anyway. Range rings and targets are the whole picture.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Aircraft } from '@/lib/types'
import { SFO } from '@/lib/adsb'
import { altitudeTag } from '@/lib/format'

type Props = {
  traffic: Aircraft[]
  /** Aircraft with a strip in the bay, drawn filled with a data block. */
  watched: Set<string>
  onClose: () => void
  /** Clicking a target puts its callsign in the command line. */
  onPick?: (a: Aircraft) => void
}

const RANGE_NM = 40
const RINGS = [10, 20, 30, 40]
const SIZES = { compact: 340, large: 520 } as const

/**
 * Nautical miles east and north of the field.
 *
 * Equirectangular, which is wrong over long distances and entirely adequate
 * over 40 nm: the longitude scale is corrected by the cosine of the field
 * latitude, and the residual error at this range is far smaller than a target
 * symbol.
 */
function toNm(a: { lat: number; lon: number }): { east: number; north: number } {
  const north = (a.lat - SFO.lat) * 60
  const east = (a.lon - SFO.lon) * 60 * Math.cos((SFO.lat * Math.PI) / 180)
  return { east, north }
}

export function ScopePanel({ traffic, watched, onClose, onPick }: Props) {
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState<keyof typeof SIZES>('compact')
  const [dragging, setDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement>(null)

  // Open near the right edge, clear of the command line.
  useEffect(() => {
    const w = SIZES[size]
    setPos({ x: Math.max(12, window.innerWidth - w - 32), y: 96 })
    // Only on first mount: after that the operator owns the position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clamp = useCallback((x: number, y: number) => {
    const el = panelRef.current
    const w = el?.offsetWidth ?? SIZES.compact
    return {
      x: Math.min(Math.max(8 - w + 80, x), window.innerWidth - 80),
      y: Math.min(Math.max(0, y), window.innerHeight - 40),
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
    setDragging(true)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return
    setPos(clamp(e.clientX - dragOffset.current.x, e.clientY - dragOffset.current.y))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(false)
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  // Keep it on screen if the window is resized under it.
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p.x, p.y))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const px = SIZES[size]
  const r = px / 2
  const scale = r / RANGE_NM // pixels per nautical mile

  const plotted = traffic
    .filter((a) => !a.onGround)
    .map((a) => {
      const { east, north } = toNm(a)
      return { a, x: r + east * scale, y: r - north * scale, rangeNm: Math.hypot(east, north) }
    })
    .filter((t) => t.rangeNm <= RANGE_NM)

  return (
    <div
      ref={panelRef}
      className="fixed z-50 border border-rule-bright bg-bay shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
      style={{ left: pos.x, top: pos.y, width: px }}
      role="dialog"
      aria-label="Traffic scope"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`flex items-center justify-between border-b border-rule bg-bay-raised px-3 py-2 select-none ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <span className="label text-ink-dim">Scope · KSFO {RANGE_NM} nm</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSize((s) => (s === 'compact' ? 'large' : 'compact'))}
            className="font-mono text-[11px] text-ink-faint hover:text-ink"
            aria-label={size === 'compact' ? 'Enlarge scope' : 'Shrink scope'}
          >
            {size === 'compact' ? '[ + ]' : '[ - ]'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] text-ink-faint hover:text-ink"
            aria-label="Close scope"
          >
            [ x ]
          </button>
        </span>
      </div>

      <svg width={px} height={px} viewBox={`0 0 ${px} ${px}`} className="block bg-bay-sunk">
        {RINGS.map((nm) => (
          <g key={nm}>
            <circle
              cx={r}
              cy={r}
              r={nm * scale}
              fill="none"
              stroke="var(--color-rule)"
              strokeWidth={1}
            />
            <text
              x={r + 3}
              y={r - nm * scale + 11}
              className="fill-ink-faint font-mono"
              fontSize={9}
            >
              {nm}
            </text>
          </g>
        ))}

        {/* Cardinal ticks. North up. */}
        <line x1={r} y1={0} x2={r} y2={px} stroke="var(--color-rule)" strokeWidth={0.5} />
        <line x1={0} y1={r} x2={px} y2={r} stroke="var(--color-rule)" strokeWidth={0.5} />
        <text x={r + 4} y={12} className="fill-ink-dim font-mono" fontSize={10}>
          N
        </text>

        {/* The field. */}
        <rect x={r - 3} y={r - 3} width={6} height={6} fill="var(--color-ink)" />

        {plotted.map(({ a, x, y }) => {
          const isWatched = watched.has(a.hex)
          const stale = a.seenPosSec > 15
          // Leader line: where the aircraft will be in one minute at its
          // current ground speed and track. This is how a controller reads
          // closure and turn rate off a scope.
          const trk = a.trackTrue ?? 0
          const oneMinuteNm = (a.gsKt ?? 0) / 60
          const lx = x + Math.sin((trk * Math.PI) / 180) * oneMinuteNm * scale
          const ly = y - Math.cos((trk * Math.PI) / 180) * oneMinuteNm * scale
          const colour = stale
            ? 'var(--color-ink-faint)'
            : isWatched
              ? 'var(--color-holder-complying)'
              : 'var(--color-ink-dim)'

          return (
            <g
              key={a.hex}
              onClick={() => onPick?.(a)}
              className={onPick ? 'cursor-pointer' : undefined}
            >
              <line x1={x} y1={y} x2={lx} y2={ly} stroke={colour} strokeWidth={1} />
              <rect
                x={x - 2.5}
                y={y - 2.5}
                width={5}
                height={5}
                fill={isWatched ? colour : 'none'}
                stroke={colour}
                strokeWidth={1.2}
              />
              {isWatched && (
                <text x={x + 7} y={y - 3} className="font-mono" fill={colour} fontSize={9}>
                  <tspan>{a.callsign ?? a.hex}</tspan>
                  <tspan x={x + 7} dy={10}>
                    {a.altFt != null ? altitudeTag(a.altFt) : '---'}{' '}
                    {a.gsKt != null ? Math.round(a.gsKt) : '---'}
                  </tspan>
                </text>
              )}
              {/* A hit area larger than the symbol, so targets are clickable. */}
              {onPick && <circle cx={x} cy={y} r={9} fill="transparent" />}
            </g>
          )
        })}
      </svg>

      <div className="flex items-center justify-between border-t border-rule px-3 py-2 font-mono text-[10px] text-ink-faint">
        <span>{plotted.length} airborne</span>
        <span>data block: altitude in hundreds of feet, ground speed</span>
      </div>
    </div>
  )
}
