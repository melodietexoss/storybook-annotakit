import { CHART_POINTS } from './mock-data'

/**
 * Nimbus Analytics — hand-rolled SVG revenue chart (no chart library).
 *
 * NOTE (demo target): the legend label uses text-[10px], which is too small
 * to read. This is an intentional agent flaw left in for the annotation demo.
 */

const PLOT = { left: 48, right: 620, top: 16, bottom: 200 }
const Y_MIN = 20000
const Y_MAX = 45000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const GRID_LABELS = ['$20k', '$28k', '$37k', '$45k']

type Point = [number, number]

const POINTS: Point[] = CHART_POINTS.map((value, index) => [
  PLOT.left + ((PLOT.right - PLOT.left) * index) / (CHART_POINTS.length - 1),
  PLOT.bottom - ((value - Y_MIN) / (Y_MAX - Y_MIN)) * (PLOT.bottom - PLOT.top),
])

const GRID_Y = GRID_LABELS.map(
  (_, index) => PLOT.bottom - ((PLOT.bottom - PLOT.top) * index) / (GRID_LABELS.length - 1),
)

const MONTH_MARKS = MONTHS.map((month, index) => ({
  month,
  x: (POINTS[index * 2][0] + POINTS[index * 2 + 1][0]) / 2,
}))

/** Catmull-Rom → cubic Bézier smoothing (pure, deterministic). */
function smoothPath(points: Point[]): string {
  if (points.length < 2) return ''
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const prev = points[i - 1] ?? points[i]
    const curr = points[i]
    const next = points[i + 1]
    const next2 = points[i + 2] ?? next
    const c1x = curr[0] + (next[0] - prev[0]) / 6
    const c1y = curr[1] + (next[1] - prev[1]) / 6
    const c2x = next[0] - (next2[0] - curr[0]) / 6
    const c2y = next[1] - (next2[1] - curr[1]) / 6
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${next[0].toFixed(1)} ${next[1].toFixed(1)}`
  }
  return d
}

function areaPath(points: Point[]): string {
  const first = points[0]
  const last = points[points.length - 1]
  return `${smoothPath(points)} L ${last[0].toFixed(1)} ${PLOT.bottom} L ${first[0].toFixed(1)} ${PLOT.bottom} Z`
}

const LINE_PATH = smoothPath(POINTS)
const AREA_PATH = areaPath(POINTS)
const LAST = POINTS[POINTS.length - 1]

export default function RevenueChart() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Revenue overview">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-slate-900">Revenue overview</h3>
          <p className="mt-0.5 text-xs text-slate-400">Monthly revenue · last 12 months</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-teal-500" aria-hidden="true" />
          <span className="text-[10px] font-medium text-slate-500">Revenue</span>
        </div>
      </div>

      <svg
        viewBox="0 0 640 240"
        className="mt-4 h-auto w-full"
        role="img"
        aria-label="Monthly revenue rising from about $20,000 in January to about $45,000 in December"
      >
        <defs>
          <linearGradient id="nimbus-revenue-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#14b8a6" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#14b8a6" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Dashed gridlines + y-axis labels */}
        {GRID_Y.map((y, index) => (
          <g key={GRID_LABELS[index]}>
            <line x1={PLOT.left} x2={PLOT.right} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="4 4" />
            <text x="40" y={y + 3.5} textAnchor="end" fontSize="10" fill="#94a3b8">
              {GRID_LABELS[index]}
            </text>
          </g>
        ))}

        {/* x-axis month labels */}
        {MONTH_MARKS.map(({ month, x }) => (
          <text key={month} x={x.toFixed(1)} y="221" textAnchor="middle" fontSize="10" fill="#94a3b8">
            {month}
          </text>
        ))}

        {/* area fill + line */}
        <path d={AREA_PATH} fill="url(#nimbus-revenue-area)" />
        <path
          d={LINE_PATH}
          fill="none"
          stroke="#0d9488"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx={LAST[0].toFixed(1)} cy={LAST[1].toFixed(1)} r="3.5" fill="#0d9488" stroke="#ffffff" strokeWidth="1.5" />
      </svg>
    </section>
  )
}
