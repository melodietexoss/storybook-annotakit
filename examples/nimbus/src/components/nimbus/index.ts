/**
 * Nimbus Analytics — public entry point for the demo mock UI.
 *
 * Pages (compositions): Dashboard, Settings, Onboarding.
 * Leaf components: Sidebar, Topbar, KpiCard, RevenueChart, StatusBadge,
 * OrdersTable, TopProducts, ProfileForm, NotificationList, ApiKeysTable,
 * DangerZone.
 * Data + types are re-exported for stories and the canvas registry.
 */

export * from './types'
export * from './mock-data'

export { default as Dashboard } from './Dashboard'
export { default as Settings } from './Settings'
export { default as Onboarding } from './Onboarding'

export { default as Sidebar } from './Sidebar'
export { default as Topbar } from './Topbar'
export { default as KpiCard } from './KpiCard'
export { default as RevenueChart } from './RevenueChart'
export { default as StatusBadge } from './StatusBadge'
export { default as OrdersTable } from './OrdersTable'
export { default as TopProducts } from './TopProducts'
export { default as ProfileForm } from './ProfileForm'
export { default as NotificationList } from './NotificationList'
export { default as ApiKeysTable } from './ApiKeysTable'
export { default as DangerZone } from './DangerZone'
