import { KPIS, ORDERS, PRODUCTS } from './mock-data'
import KpiCard from './KpiCard'
import OrdersTable from './OrdersTable'
import RevenueChart from './RevenueChart'
import Sidebar from './Sidebar'
import TopProducts from './TopProducts'
import Topbar from './Topbar'

/**
 * Nimbus Analytics — full dashboard page (demo content for the review canvas).
 * Fully static: composed from deterministic mock data, no state or effects.
 */
export default function Dashboard() {
  return (
    <div className="flex min-w-[880px] bg-slate-50">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <Topbar title="Overview" />
        <main className="space-y-6 p-6">
          <section aria-label="Key metrics" className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {KPIS.map((stat) => (
              <KpiCard key={stat.id} stat={stat} />
            ))}
          </section>
          <section aria-label="Revenue and products" className="grid gap-6 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <RevenueChart />
            </div>
            <TopProducts products={PRODUCTS} />
          </section>
          <OrdersTable orders={ORDERS} />
        </main>
      </div>
    </div>
  )
}
