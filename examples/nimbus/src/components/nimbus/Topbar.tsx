import { Bell, Search } from 'lucide-react'

/**
 * Nimbus Analytics — top bar. Plain (not sticky), white, bottom border.
 * The title is configurable so the Settings page can reuse it.
 */
export default function Topbar({ title = 'Overview' }: { title?: string }) {
  return (
    <header className="flex h-16 items-center gap-4 border-b border-slate-200 bg-white px-6">
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>

      <div className="ml-auto flex items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            placeholder="Search…"
            aria-label="Search"
            className="h-9 w-72 rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
          />
        </div>

        <button
          type="button"
          aria-label="Notifications (2 unread)"
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-50"
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" aria-hidden="true" />
        </button>

        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-100 text-xs font-semibold text-teal-700"
          aria-label="Account: Jordan Reyes"
        >
          JR
        </span>
      </div>
    </header>
  )
}
