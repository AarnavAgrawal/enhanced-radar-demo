// The trace on a strip: what the aircraft has actually done since the
// clearance, against a dashed line at the value it was assigned. Either the
// trace bends toward the dashed line or it does not, which is the verdict in
// one glance.

import type { Verdict } from '@/lib/types'

type Props = {
  values: number[]
  target: number
  verdict: Verdict
  width?: number
  height?: number
}

/** Ink on paper, so the trace is dark rather than a glowing accent. */
const TRACE: Record<Verdict, string> = {
  PENDING: '#5c646d',
  COMPLYING: '#9a6a10',
  COMPLIED: '#2f6b3d',
  DEVIATED: '#a83a2a',
  SUPERSEDED: '#6b7480',
  UNKNOWN: '#3f647c',
}

export function Sparkline({ values, target, verdict, width = 132, height = 34 }: Props) {
  if (values.length === 0) return <div style={{ width, height }} />

  const stroke = TRACE[verdict]

  // The assigned value is always in frame, so "how far off is it" is readable
  // without reading the numbers.
  const lo = Math.min(...values, target)
  const hi = Math.max(...values, target)
  const pad = Math.max((hi - lo) * 0.18, 1)
  const min = lo - pad
  const max = hi + pad

  const x = (i: number) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * width)
  const y = (v: number) => height - ((v - min) / (max - min)) * height
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const targetY = y(target)

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <line
        x1={0}
        x2={width}
        y1={targetY}
        y2={targetY}
        stroke="#15181c"
        strokeOpacity={0.35}
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.5} fill={stroke} />
    </svg>
  )
}
