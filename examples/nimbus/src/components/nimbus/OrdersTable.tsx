import { ORDERS, formatDate, formatMoney } from './mock-data'
import type { Order } from './types'
import StatusBadge from './StatusBadge'

/**
 * Nimbus Analytics — recent orders table.
 *
 * NOTE (demo targets, intentional agent flaws left in for the annotation demo):
 * 1. The "Export report" ghost button uses text-slate-400 on border-slate-200 —
 *    far too low contrast for a primary row action.
 * 2. Table cells use px-2 py-1.5, which is far too cramped for a data table.
 */
export default function OrdersTable({ orders = ORDERS }: { orders?: Order[] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="Recent orders">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h3 className="text-sm font-medium text-slate-900">Recent orders</h3>
        {/* Intentional flaw: low-contrast ghost action button. */}
        <button
          type="button"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-400 hover:bg-slate-50"
        >
          Export report
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100">
              <th scope="col" className="px-2 py-2.5 text-left text-xs font-medium uppercase text-slate-500">
                Order
              </th>
              <th scope="col" className="px-2 py-2.5 text-left text-xs font-medium uppercase text-slate-500">
                Customer
              </th>
              <th scope="col" className="px-2 py-2.5 text-left text-xs font-medium uppercase text-slate-500">
                Date
              </th>
              <th scope="col" className="px-2 py-2.5 text-right text-xs font-medium uppercase text-slate-500">
                Amount
              </th>
              <th scope="col" className="px-2 py-2.5 text-left text-xs font-medium uppercase text-slate-500">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              // Intentional flaw: body cells are far too cramped.
              <tr key={order.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                <td className="whitespace-nowrap px-2 py-1.5 font-medium text-slate-900">{order.id}</td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-col">
                    <span className="font-medium text-slate-900">{order.customer}</span>
                    <span className="text-xs text-slate-400">{order.email}</span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">{formatDate(order.date)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right font-medium text-slate-900">
                  {formatMoney(order.amount)}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  <StatusBadge status={order.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
