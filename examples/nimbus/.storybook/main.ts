import type { StorybookConfig } from '@storybook/react-vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The ONLY thing this main.ts says about review: one addons entry. No review
 * config, no API base, no proxy, no db, no dashboard. `npm run storybook` is
 * the entire review stack (the API mounts on the dev server automatically).
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['storybook-annotakit'],
  // SB 10 shows an onboarding checklist in the sidebar + a "guide" menu tab
  // in DEV mode — noise for a review surface; off for good (v0.6.3).
  features: {
    sidebarOnboardingChecklist: false,
    menuOnboardingChecklist: false,
  },
  // Serving through a reverse proxy whose edge rewrites the Host header?
  // That gets 403 "Invalid host" from the dev server's host validation
  // (DNS-rebinding guard). Both layers must allow the proxy's hosts: Vite's
  // HTTP middleware AND Storybook's websocket validation — e.g. for a
  // gateway serving *.preview.example.com:
  //   core:       { allowedHosts: ['.preview.example.com'] },
  //   server:     { allowedHosts: ['.preview.example.com'] },
  // Localhost-only setups need nothing here.
  core: {
    allowedHosts: [],
  },
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(config) {
    config.plugins = [...(config.plugins ?? []), tailwindcss()];
    config.server ??= {};
    config.server.allowedHosts = [...(config.server.allowedHosts ?? [])];
    config.resolve ??= {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      '@': path.resolve(dirname, '../src'),
    };
    return config;
  },
};

export default config;
