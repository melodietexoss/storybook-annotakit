import { ChevronDown, Cloud } from 'lucide-react'
import { NAV_ITEMS } from './mock-data'

const ACTIVE_ID = 'dashboard'

/**
 * Nimbus Analytics — app sidebar.
 *
 * NOTE (demo target): the active nav item is intentionally under-styled
 * (bg-slate-100 + text-slate-500 vs. text-slate-400 inactive) so active and
 * inactive items look nearly identical. This is an intentional agent flaw
 * left in for the annotation demo.
 */
export default function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* Brand */}
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50">
          <Cloud className="h-5 w-5 text-teal-600" aria-hidden="true" />
        </span>
        <span className="text-base font-semibold text-slate-900">Nimbus</span>
      </div>

      {/* Workspace switcher */}
      <div className="border-b border-slate-100 px-3 py-3">
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-slate-50"
          aria-label="Switch workspace — currently Acme Inc"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-600 text-xs font-semibold text-white">
            A
          </span>
          <span className="flex-1 min-w-0 truncate text-left text-sm font-medium text-slate-900">Acme Inc</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        </button>
      </div>

      {/* Primary nav */}
      <nav aria-label="Main navigation" className="flex-1 space-y-1 px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const active = item.id === ACTIVE_ID
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              className={
                // Intentional flaw: active state is far too subtle.
                active
                  ? 'flex w-full items-center gap-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-500'
                  : 'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-50 hover:text-slate-600'
              }
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {item.label}
            </button>
          )
        })}
      </nav>

      {/* Current user */}
      <div className="mt-auto border-t border-slate-100 p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-xs font-semibold text-teal-700">
            JR
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">Jordan Reyes</p>
            <p className="text-xs text-slate-400">Pro plan</p>
          </div>
        </div>
      </div>
    </aside>
  )
}
