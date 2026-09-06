/**
 * Nimbus Analytics — profile form card.
 *
 * NOTE (demo target): the helper text under the Email field uses text-[11px]
 * text-slate-400 — too small and too low contrast. This is an intentional
 * agent flaw left in for the annotation demo.
 */
export default function ProfileForm() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm" aria-label="Profile">
      <div className="border-b border-slate-100 px-5 py-4">
        <h3 className="text-sm font-medium text-slate-900">Profile</h3>
        <p className="mt-0.5 text-xs text-slate-400">How you appear across your workspace.</p>
      </div>

      <div className="space-y-5 p-5">
        <div>
          <label htmlFor="profile-full-name" className="block text-sm font-medium text-slate-700">
            Full name
          </label>
          <input
            id="profile-full-name"
            type="text"
            defaultValue="Jordan Reyes"
            placeholder="Jane Cooper"
            className="mt-1.5 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="profile-email" className="block text-sm font-medium text-slate-700">
            Email
          </label>
          <input
            id="profile-email"
            type="email"
            defaultValue="jordan@acme.com"
            placeholder="jordan@acme.com"
            className="mt-1.5 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
          />
          {/* Intentional flaw: helper text is far too small. */}
          <p className="mt-1.5 text-[11px] text-slate-400">We&rsquo;ll never share your email.</p>
        </div>

        <div>
          <label htmlFor="profile-bio" className="block text-sm font-medium text-slate-700">
            Bio
          </label>
          <textarea
            id="profile-bio"
            rows={3}
            defaultValue="Running the Acme Inc storefront on Nimbus. Coffee, dashboards, and clean data."
            placeholder="Tell us a little about yourself"
            className="mt-1.5 block w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
          />
        </div>
      </div>
    </section>
  )
}
