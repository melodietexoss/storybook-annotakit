import ApiKeysTable from './ApiKeysTable'
import DangerZone from './DangerZone'
import NotificationList from './NotificationList'
import ProfileForm from './ProfileForm'
import Sidebar from './Sidebar'
import Topbar from './Topbar'

/**
 * Nimbus Analytics — full settings page (demo content for the review canvas).
 * Fully static: composed from deterministic mock components, no state or effects.
 */
export default function Settings() {
  return (
    <div className="flex min-w-[880px] bg-slate-50">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <Topbar title="Settings" />
        <main className="mx-auto max-w-2xl space-y-6 p-6">
          <ProfileForm />
          <NotificationList />
          <ApiKeysTable />
          <DangerZone />
        </main>
      </div>
    </div>
  )
}
