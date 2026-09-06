import { defineConfig } from 'tsup';

// Storybook's manager and preview runtimes provide these modules — they must
// stay external (same lesson as greenroom: bundling them breaks the manager's
// React element symbols).
const storybookProvided = [
  'react',
  'react-dom',
  '@storybook/icons',
  'react/jsx-runtime',
  'react-dom/client',
  /^storybook\/.*/,
];

export default [
  // Browser bundles: manager panel + preview overlay.
  defineConfig({
    entry: {
      manager: 'src/manager/index.tsx',
      preview: 'src/preview/index.ts',
      // standalone export so node tests can exercise the static-mode store
      // (the manager/preview bundles embed their own copy — state is
      // per-document by design; cross-doc sync rides storage events).
      staticStore: 'src/shared/staticStore.ts',
      // v0.5.3: client-side GitHub publisher — same standalone-export pattern
      // (tests drive it with an injected transport + localStorage shims).
      ghClient: 'src/shared/ghClient.ts',
    },
    format: ['esm'],
    platform: 'browser',
    clean: false,
    external: storybookProvided,
    noExternal: ['@medv/finder'],
    outExtension: () => ({ js: '.mjs' }),
    esbuildOptions(options) {
      // Classic JSX transform: the manager renders with Storybook's own React;
      // the automatic runtime would resolve react/jsx-runtime from OUR React
      // version → mismatched element symbols → React error #31.
      options.jsx = 'transform';
    },
  }),
  // Node bundle: dev-server middleware + sqlite store + digest + gh publisher.
  defineConfig({
    entry: { server: 'src/server/routes.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    // BOTH configs share dist/ and tsup runs them in parallel — a clean:true
    // on either can wipe the other's output mid-build depending on execution
    // order (an intermittent, order-dependent failure). Keep clean:false
    // here; the build script rm -rf's dist exactly once, BEFORE tsup.
    clean: false,
    outExtension: () => ({ js: '.cjs' }),
    dts: false,
    splitting: false,
    treeshake: true,
  }),
];
