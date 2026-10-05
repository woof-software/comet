import { migration } from '../Migration.js';

export default migration('test migration', {
  prepare: async (_deploymentManager) => {
    return ['step 1'];
  },
  enact: async (_deploymentManager, _x) => {
    // no-op...
  }
});
