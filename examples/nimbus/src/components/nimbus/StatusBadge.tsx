import type { OrderStatus } from './types'

const VARIANTS: Record<OrderStatus, string> = {
  shipped: 'bg-teal-50 text-teal-700',
  delivered: 'bg-emerald-50 text-emerald-700',
  pending: 'bg-amber-50 text-amber-700',
  refunded: 'bg-rose-50 text-rose-700',
}

/** Nimbus Analytics — order status pill badge. */
export default function StatusBadge({ status }: { status: OrderStatus }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${VARIANTS[status]}`}
    >
      {/* review feedback (#24/#25): the pending dot pulses — an order awaiting
       *  fulfillment reads as "in flight", not a static state */}
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current opacity-70 ${status === 'pending' ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}
