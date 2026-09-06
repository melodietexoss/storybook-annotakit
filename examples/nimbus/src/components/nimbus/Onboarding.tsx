import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { CHECKLIST, ONBOARDING_STEPS } from './mock-data'

/**
 * Nimbus Analytics — standalone onboarding wizard (no sidebar).
 *
 * NOTE (demo targets, intentional agent flaws left in for the annotation demo):
 * 1. The step indicator row uses gap-1 — the connector lines nearly touch the
 *    numbered circles (cramped).
 * 2. Unchecked checklist labels use text-slate-400 — too low contrast.
 * 3. The primary "Continue" CTA uses a light teal ghost style (bg-teal-50,
 *    text-teal-500, border-teal-100) instead of a solid fill — it reads as a
 *    disabled/secondary button.
 */
export default function Onboarding() {
  const doneCount = CHECKLIST.filter((item) => item.done).length

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Set up your store</h1>
        <p className="mt-1 text-sm text-slate-500">
          Two steps left to finish setting up your workspace.
        </p>

        {/* Step indicator — intentional flaw: gap-1 is far too cramped. */}
        <ol className="mt-8 flex items-center gap-1">
          {ONBOARDING_STEPS.map((step, index) => (
            <Fragment key={step.id}>
              {index > 0 && (
                <span
                  className={`h-px flex-1 ${ONBOARDING_STEPS[index - 1].done ? 'bg-teal-500' : 'bg-slate-200'}`}
                  aria-hidden="true"
                />
              )}
              <li className="flex shrink-0 items-center gap-2">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium ${
                    step.done ? 'bg-teal-600 text-white' : 'border border-slate-200 bg-white text-slate-400'
                  }`}
                >
                  {step.done ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </span>
                <span
                  className={`whitespace-nowrap text-sm font-medium ${
                    step.done ? 'text-slate-900' : 'text-slate-400'
                  }`}
                >
                  {step.title}
                </span>
              </li>
            </Fragment>
          ))}
        </ol>

        {/* Overall progress */}
        <div className="mt-5 h-1 w-full rounded bg-slate-100" role="progressbar" aria-valuenow={66} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-1 rounded bg-teal-500" style={{ width: '66%' }} />
        </div>

        {/* Checklist */}
        <div className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-900">Setup checklist</h2>
            <p className="text-xs text-slate-500">
              {doneCount} of {CHECKLIST.length} complete
            </p>
          </div>
          <ul className="mt-4 space-y-3">
            {CHECKLIST.map((item) => (
              <li key={item.id} className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                    item.done ? 'border-teal-600 bg-teal-600' : 'border-slate-300 bg-white'
                  }`}
                >
                  {item.done && <Check className="h-3 w-3 text-white" />}
                </span>
                {/* Intentional flaw: unchecked labels are too low contrast. */}
                <span className={`text-sm ${item.done ? 'text-slate-700' : 'text-slate-400'}`}>
                  {item.label}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Actions — intentional flaw: low-contrast primary CTA. */}
        <div className="mt-8 flex items-center justify-between">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Back
          </button>
          <button
            type="button"
            className="rounded-lg border border-teal-100 bg-teal-50 px-4 py-2 text-sm font-medium text-teal-500"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
