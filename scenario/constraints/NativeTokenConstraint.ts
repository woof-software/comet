import { StaticConstraint } from '../../plugins/scenario/index.js';
import { CometContext } from '../context/CometContext.js';
import { exp } from '../../test/helpers.js';

export class NativeTokenConstraint<T extends CometContext> implements StaticConstraint<T> {
  async solve() {
    return [
      async function (ctx: T): Promise<T> {
        for (const symbol in ctx.assets) {
          const contract = await ctx.world.deploymentManager.contract(symbol);
          if (contract && contract['deposit()'] && contract['withdraw(uint256)']) {
            const [whale]= await ctx.getWhales();
            if (!whale) {
              throw new Error(`NativeTokenConstraint: no whale found for ${ctx.world.deploymentManager.network}`);
            }
            const amount = exp(200_000, await contract.decimals());
            // can make this more sophisticated as needed...
            await contract.deposit({ value: amount });
            await contract.transfer(whale, amount);
          }
        }
        return ctx;
      }
    ];
  }

  async check() {
    // ...
  }
}
