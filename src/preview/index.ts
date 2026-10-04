/**
 * storybook-annotakit — preview entry.
 *
 * Registers ONE global decorator via `previewAnnotations` (the preset wires this
 * module in): every story gets the review layer automatically. Storybook is the
 * host; the addon asks nothing of the user. Per-story options:
 *
 *   parameters: {
 *     annotakit: {
 *       disabled: true,                       // opt this story out
 *       hotkeys: { pin: 'k', region: 'x' },   // customize shortcuts
 *       hotkeys: false,                       // disable shortcuts (UI only)
 *     },
 *   }
 */

import React from 'react';
import { AnnotaLayer, type Hotkeys } from './layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const decorators = [
  (StoryFn: () => React.ReactElement, context: any) => {
    if (context?.viewMode === 'docs') return React.createElement(StoryFn);
    const params = context?.parameters?.annotakit as
      | { disabled?: boolean; hotkeys?: Partial<Hotkeys> | false }
      | undefined;
    if (params?.disabled) return React.createElement(StoryFn);

    const storyId: string = context?.id ?? '';
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(StoryFn),
      React.createElement(AnnotaLayer, {
        storyId,
        title: context?.title,
        name: context?.name,
        hotkeys: params?.hotkeys,
      }),
    );
  },
];
