import { Constraint, World } from '../../plugins/scenario';
import { CometContext } from '../context/CometContext';
import { expect } from 'chai';
import { Requirements } from './Requirements';
import { utils } from 'ethers';
import { Timelock, Timelock__factory } from '../../build/types';
import { advanceToTimestamp, getLatestBlockTimestamp, setNextBlockTimestamp } from '../utils/hreUtils';

function resolveTarget(context: CometContext, target: string): string {
  return target.startsWith('0x') ? target : context.actors[target].address;
}

async function connectTimelock(context: CometContext): Promise<Timelock> {
  const dm = context.world.deploymentManager;
  return Timelock__factory.connect((await context.getTimelock()).address, dm.hre.ethers.provider);
}

/**
 * Establishes the precondition "timelock.pendingAdmin() == X" by queueing and
 * executing a setPendingAdmin(address) self-call on the timelock as its admin.
 * Declared via the `timelockPendingAdmin` requirement key with an actor name
 * (e.g. 'betty') or a literal address (e.g. address(0)). No-ops if the fork
 * already satisfies the target value.
 */
export class TimelockPendingAdminConstraint<T extends CometContext, R extends Requirements> implements Constraint<T, R> {
  async solve(requirements: R, _context: T) {
    const target = requirements.timelockPendingAdmin;
    if (target === undefined) {
      return null;
    }

    return async (ctx: T) => {
      const dm = ctx.world.deploymentManager;
      const timelock = await connectTimelock(ctx);
      const newPendingAdmin = resolveTarget(ctx, target);
      if ((await timelock.pendingAdmin()) === newPendingAdmin) {
        return; // fork state already satisfies the requirement
      }
      const admin = await ctx.world.impersonateAddress(await timelock.admin(), { value: 10n ** 18n, onGovNetwork: true });

      const data = utils.defaultAbiCoder.encode(['address'], [newPendingAdmin]);
      const eta = (await getLatestBlockTimestamp(dm)) + (await timelock.delay()).toNumber() + 1;
      await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
      await timelock.connect(admin).queueTransaction(timelock.address, 0, 'setPendingAdmin(address)', data, eta);
      await advanceToTimestamp(dm, eta);
      await timelock.connect(admin).executeTransaction(timelock.address, 0, 'setPendingAdmin(address)', data, eta);
    };
  }

  async check(requirements: R, context: T, _world: World) {
    const target = requirements.timelockPendingAdmin;
    if (target === undefined) {
      return;
    }
    const timelock = await connectTimelock(context);
    expect(await timelock.pendingAdmin()).to.equal(resolveTarget(context, target));
  }
}
