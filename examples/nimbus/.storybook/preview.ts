import type { Preview } from '@storybook/react-vite';

import '../src/globals.css';

/**
 * Deliberately EMPTY of review configuration — that's the point. The
 * storybook-annotakit decorator mounts on every story by itself; the store and
 * API live on the dev server. Nothing to wire here.
 */
const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    backgrounds: { default: 'light' },
  },
};

export default preview;
