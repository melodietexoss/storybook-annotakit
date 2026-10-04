import { PRODUCTS, formatMoney } from './mock-data'
import type { Product } from './types'

/** Tiny inline sparkline (pure SVG, deterministic). */
function Sparkline({ trend }: { trend: number[] }) {
  const min = Math.min(...trend)
  const max = Math.max(...trend)
  const range = max - min || 1
  const points = trend
    .map((value, index) => {
      const x = (64 * index) / (trend.length - 1)
      const y = 21 - ((value - min) / range) * 18
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 64 24" className="h-6 w-16 shrink-0" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke="#0d9488"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Nimbus Analytics — top products list with mini sparklines. */
export default function TopProducts({ products = PRODUCTS }: { products?: Product[] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="Top products">
      <div className="border-b border-slate-100 px-5 py-4">
        <h3 className="text-sm font-medium text-slate-900">Top products</h3>
        <p className="mt-0.5 text-xs text-slate-400">By revenue · last 12 months</p>
      </div>
      <ul className="divide-y divide-slate-100">
        {products.map((product) => (
          <li key={product.name} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900">{product.name}</p>
              <p className="text-xs text-slate-400">{product.category}</p>
            </div>
            <Sparkline trend={product.trend} />
            <p className="w-20 shrink-0 text-right text-sm font-medium text-slate-900">
              {formatMoney(product.revenue, 0)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
