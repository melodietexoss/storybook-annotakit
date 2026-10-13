import type { Meta, StoryObj } from '@storybook/react-vite';

import { DisabledKit } from '../components/nimbus/DisabledKit';

const meta: Meta<typeof DisabledKit> = {
  title: 'Nimbus/Greyed Out',
  component: DisabledKit,
};
export default meta;

export const GreyedStory: StoryObj<typeof DisabledKit> = {};

/** S6-D7 E2E fixture: the frozen-view feature flag OFF — freeze entry points
 *  (⌥I, toolbar button, freeze command) must be refused/hidden while the
 *  base pin/region flow stays fully functional. */
export const GreyedNoFrozenView: StoryObj<typeof DisabledKit> = {
  parameters: { annotakit: { frozenView: false } },
};
