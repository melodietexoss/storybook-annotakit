import type { LucideIcon } from 'lucide-react'

/**
 * Nimbus Analytics — shared types for the demo mock UI.
 *
 * This mock is demo content rendered inside the AnnotaKit review canvas.
 * It must stay fully static and server-renderable: no hooks, no state,
 * no browser APIs, deterministic data only (fixed ISO date strings).
 */

/** Order fulfillment status used across the Orders table. */
export type OrderStatus = 'shipped' | 'delivered' | 'pending' | 'refunded'

export interface Order {
  id: string
  customer: string
  email: string
  /** Fixed ISO date string, e.g. "2025-06-18" (never relative to now). */
  date: string
  amount: number
  status: OrderStatus
}

export interface Product {
  name: string
  category: string
  revenue: number
  /** 12 monthly values, oldest first — feeds the mini sparkline. */
  trend: number[]
}

export interface KpiStat {
  id: string
  label: string
  /** Pre-formatted display value, e.g. "$84,254" or "3m 42s". */
  value: string
  /** Signed percentage change vs. the previous period. */
  delta: number
  deltaLabel: string
}

export interface NavItem {
  id: string
  label: string
  icon: LucideIcon
}

export interface NotificationPref {
  id: string
  label: string
  description: string
  enabled: boolean
}

export interface ApiKey {
  id: string
  name: string
  /** Redacted key prefix, e.g. "sk_live_7f3a…9c21". */
  prefix: string
  /** Fixed ISO date string of last use. */
  lastUsed: string
}

export interface OnboardingStep {
  id: string
  title: string
  done: boolean
}

export interface ChecklistItem {
  id: string
  label: string
  done: boolean
}
