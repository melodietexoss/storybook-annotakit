/**
 * Nimbus Analytics — danger zone card.
 *
 * NOTE (demo target): the card border is border-rose-200 — visually almost
 * identical to a neutral slate border, far too subtle for a destructive
 * action zone. This is an intentional agent flaw left in for the annotation
 * demo.
 */
export default function DangerZone() {
  return (
    <section className="rounded-xl border border-rose-200 bg-white p-5" aria-label="Danger zone">
      <h3 className="text-sm font-semibold text-slate-900">Danger zone</h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">
        Permanently delete this workspace along with all orders, customers, and API keys. This action
        cannot be undone.
      </p>
      <button
        type="button"
        className="mt-4 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700"
      >
        Delete workspace
      </button>
    </section>
  )
}
