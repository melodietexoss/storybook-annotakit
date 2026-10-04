/**
 * Nimbus leaf component stories — NO review parameters (the addon decorates
 * every story globally; component metadata is derived at pin time from the
 * React fiber + story index).
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  ApiKeysTable,
  DangerZone,
  KpiCard,
  KPIS,
  NotificationList,
  OrdersTable,
  ProfileForm,
  RevenueChart,
  Sidebar,
  StatusBadge,
  TopProducts,
} from '@/components/nimbus';

type Story = StoryObj;

const meta = {
  title: 'Nimbus/Components',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

export const KpiCardStory: Story = {
  name: 'KPI Card',
  render: () => (
    <div className="inline-block bg-white p-6" style={{ width: 280 }}>
      <KpiCard stat={KPIS[0]!} />
    </div>
  ),
};

export const RevenueChartStory: Story = {
  name: 'Revenue Chart',
  render: () => (
    <div className="inline-block bg-white p-6" style={{ width: 760 }}>
      <RevenueChart />
    </div>
  ),
};

export const OrdersTableStory: Story = {
  name: 'Orders Table',
  render: () => (
    <div className="inline-block bg-white p-6" style={{ width: 760 }}>
      <OrdersTable />
    </div>
  ),
};

export const StatusBadgeStory: Story = {
  name: 'Status Badge',
  render: () => (
    <div className="inline-block bg-white p-6">
      <div className="flex items-center gap-3">
        {(['shipped', 'delivered', 'pending', 'refunded'] as const).map((s) => (
          <StatusBadge key={s} status={s} />
        ))}
      </div>
    </div>
  ),
};

export const SidebarStory: Story = {
  name: 'Sidebar',
  render: () => (
    <div className="inline-block bg-white">
      <Sidebar />
    </div>
  ),
};

export const TopProductsStory: Story = {
  name: 'Top Products',
  render: () => (
    <div className="inline-block bg-white p-6" style={{ width: 420 }}>
      <TopProducts />
    </div>
  ),
};

export const ProfileFormStory: Story = {
  name: 'Profile Form',
  render: () => (
    <div className="inline-block bg-white p-6" style={{ width: 480 }}>
      <ProfileForm />
    </div>
  ),
};

export const NotificationListStory: Story = {
  name: 'Notification List',
  render: () => (
    <div className="inline-block bg-white p-6" style={{ width: 420 }}>
      <NotificationList />
    </div>
  ),
};

export const ApiKeysTableStory: Story = {
  name: 'API Keys',
  render: () => (
    <div className="inline-block bg-white p-6" style={{ width: 640 }}>
      <ApiKeysTable />
    </div>
  ),
};

export const DangerZoneStory: Story = {
  name: 'Danger Zone',
  render: () => (
    <div className="inline-block bg-white p-6" style={{ width: 640 }}>
      <DangerZone />
    </div>
  ),
};
