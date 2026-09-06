import { NOTIFICATIONS } from './mock-data'
import type { NotificationPref } from './types'

/** Pure visual toggle — no state, purely presentational. */
function Toggle({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <div
      role="switch"
      aria-checked={enabled}
      aria-label={`${label} notifications`}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 ${
        enabled ? 'bg-emerald-600' : 'bg-slate-200'
      }`}
    >
      <span
        className={`h-4 w-4 rounded-full bg-white shadow-sm ${enabled ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </div>
  )
}

/**
 * Nimbus Analytics — notification preferences card.
 *
 * NOTE (demo targets, intentional agent flaws left in for the annotation demo):
 * rows use py-1.5 with gap-0 (cramped), and the pill is not vertically
 * aligned with its label (items-start).
 */
export default function NotificationList() {
  const prefs: NotificationPref[] = NOTIFICATIONS
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="Notifications">
      <div className="border-b border-slate-100 px-5 py-4">
        <h3 className="text-sm font-medium text-slate-900">Notifications</h3>
        <p className="mt-0.5 text-xs text-slate-400">Choose what you want to hear about.</p>
      </div>
      <ul className="divide-y divide-slate-100">
        {prefs.map((pref) => (
          // Intentional flaw: cramped rows, mis-aligned toggle.
          <li key={pref.id} className="flex items-start justify-between gap-0 px-5 py-1.5">
            <div className="pr-4">
              <p className="text-sm font-medium text-slate-900">{pref.label}</p>
              <p className="mt-0.5 text-xs text-slate-500">{pref.description}</p>
            </div>
            <Toggle enabled={pref.enabled} label={pref.label} />
          </li>
        ))}
      </ul>
    </section>
  )
}
