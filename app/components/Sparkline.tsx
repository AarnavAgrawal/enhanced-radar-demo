// A small trend line with the assigned value drawn across it. This is the
// visual that makes a verdict legible at a glance: the line either bends toward
// the dashed reference or it does not.

type Props = {
  values: number[]
  target: number
  /** Colours the trace to match the verdict badge. */
  tone: 'pending' | 'complying' | 'complied' | 'deviated' | 'closed'
  width?: number
  height?: number
}

const TONE_STROKE: Record<Props['tone'], string> = {
  pending: '#94a3b8', // slate 400
  complying: '#fbbf24', // amber 400
  complied: '#34d399', // emerald 400
  deviated: '#f87171', // red 400
  closed: '#64748b', // slate 500
}

export function Sparkline({ values, target, tone, width = 150, height = 40 }: Props) {
  if (values.length === 0) return <div style={{ width, height }} />

  // The reference line is always in frame, so "how far is it from the assigned
  // value" is readable without checking the numbers.
  const lo = Math.min(...values, target)
  const hi = Math.max(...values, target)
  // A flat trace at the assigned value would otherwise divide by zero and, worse,
  // would draw as if it were pinned to an edge.
  const pad = Math.max((hi - lo) * 0.15, 1)
  const min = lo - pad
  const max = hi + pad

  const x = (i: number) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * width)
  const y = (v: number) => height - ((v - min) / (max - min)) * height

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const targetY = y(target)
  const stroke = TONE_STROKE[tone]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
    >
      {/* The assigned value. */}
      <line
        x1={0}
        x2={width}
        y1={targetY}
        y2={targetY}
        stroke="#64748b"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} />
      {/* Where the aircraft is now. */}
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.5} fill={stroke} />
    </svg>
  )
}
