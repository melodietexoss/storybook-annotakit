import { HardDrive } from 'lucide-react'
import { API_KEYS, formatDate } from './mock-data'

/**
 * Nimbus Analytics — API keys card.
 *
 * NOTE (demo target): the "Revoke" action uses text-xs text-rose-500 inside an
 * h-6 px-2 button — a tiny touch target that is hard to hit and easy to
 * mis-tap. This is an intentional agent flaw left in for the annotation demo.
 */
export default function ApiKeysTable() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="API keys">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
        <HardDrive className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <div>
          <h3 className="text-sm font-medium text-slate-900">API keys</h3>
          <p className="mt-0.5 text-xs text-slate-400">Keys with access to this workspace.</p>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {API_KEYS.map((key) => (
          <li key={key.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-900">{key.name}</p>
              <p className="mt-0.5 font-mono text-xs text-slate-500">{key.prefix}</p>
            </div>
            <div className="flex shrink-0 items-center gap-6">
              <p className="text-xs text-slate-400">Last used {formatDate(key.lastUsed)}</p>
              {/* Intentional flaw: tiny touch target on a destructive action. */}
              <button
                type="button"
                className="inline-flex h-6 items-center rounded px-2 text-xs font-medium text-rose-500 hover:bg-rose-50"
              >
                Revoke
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
