import type { HardhatPlugin } from 'hardhat/types/plugins';

import { definePlugin } from 'hardhat/plugins';

const sourceFilterPlugin: HardhatPlugin = definePlugin({
  id: 'comet-source-filter',
  hookHandlers: {
    solidity: () => import('./source-filter.js'),
  },
});

export default sourceFilterPlugin;
