import {
  BarChart3,
  LayoutDashboard,
  Package,
  Settings as SettingsIcon,
  ShoppingCart,
  Users,
} from 'lucide-react'
import type {
  ApiKey,
  ChecklistItem,
  KpiStat,
  NavItem,
  NotificationPref,
  OnboardingStep,
  Order,
  Product,
} from './types'

/**
 * Nimbus Analytics — deterministic mock data.
 *
 * All values are fixed constants: no dates relative to "now", no randomness.
 * The two formatters at the bottom are pure functions so the mock renders
 * identically on the server and the client.
 */

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'orders', label: 'Orders', icon: ShoppingCart },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

export const KPIS: KpiStat[] = [
  { id: 'total-revenue', label: 'Total revenue', value: '$84,254', delta: 12.4, deltaLabel: 'vs. last month' },
  { id: 'active-users', label: 'Active users', value: '2,841', delta: 8.2, deltaLabel: 'vs. last month' },
  { id: 'orders', label: 'Orders', value: '1,204', delta: -2.1, deltaLabel: 'vs. last month' },
  { id: 'avg-session', label: 'Avg. session', value: '3m 42s', delta: 4.7, deltaLabel: 'vs. last month' },
]

export const ORDERS: Order[] = [
  { id: '#NB-2093', customer: 'Amelia Hart', email: 'amelia.hart@outlook.com', date: '2025-06-18', amount: 248.0, status: 'delivered' },
  { id: '#NB-2092', customer: 'Marcus Chen', email: 'm.chen@quantacore.io', date: '2025-06-18', amount: 1199.0, status: 'shipped' },
  { id: '#NB-2091', customer: 'Priya Raman', email: 'priya@ramanstudios.com', date: '2025-06-17', amount: 86.4, status: 'pending' },
  { id: '#NB-2090', customer: 'Sofia Delgado', email: 'sofia.delgado@gmail.com', date: '2025-06-17', amount: 432.5, status: 'delivered' },
  { id: '#NB-2089', customer: 'Jonas Weber', email: 'j.weber@mailbox.de', date: '2025-06-16', amount: 129.0, status: 'refunded' },
  { id: '#NB-2088', customer: 'Aisha Okafor', email: 'aisha.okafor@brightloop.co', date: '2025-06-16', amount: 765.0, status: 'shipped' },
  { id: '#NB-2087', customer: 'Tomás Silva', email: 'tomas.silva@fastmail.com', date: '2025-06-15', amount: 54.99, status: 'delivered' },
  { id: '#NB-2086', customer: 'Hannah Kim', email: 'hannah.kim@nodetech.dev', date: '2025-06-15', amount: 940.25, status: 'pending' },
  { id: '#NB-2085', customer: 'Oliver Grant', email: 'ollie.grant@proton.me', date: '2025-06-14', amount: 312.0, status: 'shipped' },
  { id: '#NB-2084', customer: 'Nadia Petrova', email: 'nadia.p@auroraworks.net', date: '2025-06-14', amount: 188.75, status: 'delivered' },
]

export const PRODUCTS: Product[] = [
  {
    name: 'Nimbus Pro Plan',
    category: 'Subscription',
    revenue: 32480,
    trend: [180, 205, 198, 224, 241, 232, 258, 271, 262, 289, 304, 318],
  },
  {
    name: 'Team Seats (10-pack)',
    category: 'Subscription',
    revenue: 18960,
    trend: [120, 132, 128, 141, 138, 152, 149, 161, 158, 170, 168, 182],
  },
  {
    name: 'Analytics Add-on',
    category: 'Add-on',
    revenue: 11240,
    trend: [64, 70, 68, 75, 82, 79, 88, 84, 92, 97, 104, 110],
  },
  {
    name: 'Priority Support',
    category: 'Service',
    revenue: 8420,
    trend: [40, 44, 42, 48, 47, 52, 55, 53, 58, 61, 60, 66],
  },
  {
    name: 'Data Export Pack',
    category: 'Add-on',
    revenue: 5140,
    trend: [30, 28, 34, 32, 38, 36, 42, 40, 45, 44, 50, 54],
  },
]

export const NOTIFICATIONS: NotificationPref[] = [
  {
    id: 'order-alerts',
    label: 'Order alerts',
    description: 'Get notified as soon as a new order comes in.',
    enabled: true,
  },
  {
    id: 'weekly-digest',
    label: 'Weekly digest',
    description: 'A summary of your store performance, every Monday.',
    enabled: true,
  },
  {
    id: 'product-reviews',
    label: 'Product reviews',
    description: 'Alerts when a customer leaves a product review.',
    enabled: false,
  },
  {
    id: 'security-alerts',
    label: 'Security alerts',
    description: 'Unusual sign-in attempts and API key activity.',
    enabled: true,
  },
]

export const API_KEYS: ApiKey[] = [
  { id: 'key-prod-web', name: 'Production — Web app', prefix: 'sk_live_7f3a…9c21', lastUsed: '2025-06-18' },
  { id: 'key-ci-pipeline', name: 'CI pipeline', prefix: 'sk_live_1d84…4b7e', lastUsed: '2025-06-12' },
]

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 'company-details', title: 'Company details', done: true },
  { id: 'invite-team', title: 'Invite team', done: true },
  { id: 'connect-store', title: 'Connect store', done: false },
]

export const CHECKLIST: ChecklistItem[] = [
  { id: 'verify-email', label: 'Verify your email address', done: true },
  { id: 'add-logo', label: 'Add your store logo', done: true },
  { id: 'payment-provider', label: 'Connect a payment provider', done: true },
  { id: 'first-product', label: 'Create your first product', done: false },
  { id: 'invite-teammate', label: 'Invite a teammate', done: false },
]

/** 24 half-month samples — an organic-looking rise from ~$20k to ~$45k with dips. */
export const CHART_POINTS: number[] = [
  20200, 21400, 20800, 22600, 23900, 23200, 25700, 27100, 26200, 28800,
  30200, 29300, 31800, 31100, 33600, 35100, 34200, 36900, 36100, 38800,
  38100, 41200, 40400, 44800,
]

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "$1,240.00" — pure, locale-independent currency formatting. */
export function formatMoney(amount: number, decimals = 2): string {
  const fixed = Math.abs(amount).toFixed(decimals)
  const [intPart, fracPart] = fixed.split('.')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = fracPart ? `${grouped}.${fracPart}` : grouped
  return amount < 0 ? `-$${body}` : `$${body}`
}

/** "2025-06-18" → "Jun 18, 2025" — pure, no Date parsing. */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10))
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`
}
