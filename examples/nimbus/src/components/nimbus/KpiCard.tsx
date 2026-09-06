import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import type { KpiStat } from './types'

function formatDelta(delta: number): string {
  const prefix = delta > 0 ? '+' : ''
  return `${prefix}${delta.toFixed(1)}%`
}

/**
 * Nimbus Analytics — KPI stat card.
 *
 * NOTE (demo target): the "Active users" stat renders its POSITIVE delta in
 * rose-600, copying the negative-delta styling. All other positive deltas
 * correctly use emerald-600. This is an intentional agent flaw left in for
 * the annotation demo.
 */
export default function KpiCard({ stat }: { stat: KpiStat }) {
  const positive = stat.delta > 0
  const miscolored = stat.id === 'active-users'
  const chipBg = positive && !miscolored ? 'bg-emerald-50' : 'bg-rose-50'
  const chipText = positive && !miscolored ? 'text-emerald-600' : 'text-rose-600'
  const DeltaIcon = positive ? ArrowUpRight : ArrowDownRight

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-slate-500">{stat.label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-slate-900">{stat.value}</p>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${chipBg} ${chipText}`}
        >
          <DeltaIcon className="h-3 w-3" aria-hidden="true" />
          {formatDelta(stat.delta)}
        </span>
        <span className="text-xs text-slate-400">{stat.deltaLabel}</span>
      </div>
    </article>
  )
}
