/**
 * Nimbus full-page stories — no review parameters. Comment flow works by
 * default; the fiber walk reports the page-level component chains.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

import { Dashboard, Onboarding, Settings } from '@/components/nimbus';

type Story = StoryObj;

const meta = {
  title: 'Nimbus/Pages',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

export const DashboardStory: Story = {
  name: 'Dashboard',
  render: () => (
    <div className="inline-block bg-white" style={{ minWidth: 880 }}>
      <Dashboard />
    </div>
  ),
};

export const SettingsStory: Story = {
  name: 'Settings',
  render: () => (
    <div className="inline-block bg-white" style={{ minWidth: 880 }}>
      <Settings />
    </div>
  ),
};

export const OnboardingStory: Story = {
  name: 'Onboarding',
  render: () => (
    <div className="inline-block bg-white" style={{ minWidth: 880 }}>
      <Onboarding />
    </div>
  ),
};
