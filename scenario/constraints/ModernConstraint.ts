import { Constraint } from '../../plugins/scenario';
import { Solution } from '../../plugins/scenario/Scenario';
import { CometContext } from '../context/CometContext';
import { getFuzzedRequirements } from './Fuzzing';
import { Requirements } from './Requirements';

export class ModernConstraint<T extends CometContext, R extends Requirements> implements Constraint<T, R> {
  async solve(requirements: R, context: T) {
    let resolvedRequirements = { ...requirements };
    if (typeof requirements.upgrade === 'function') {
      resolvedRequirements.upgrade = await requirements.upgrade(context);
    }
    
    const fuzzed = await getFuzzedRequirements(resolvedRequirements);
    const solutions: Solution<T>[] = [];
    
    for (const req of fuzzed) {
      if (req.upgrade) {
        solutions.push(async function solution(ctx: T): Promise<T> {
          const current = await ctx.getConfiguration();
          const upgrade = Object.assign({}, current, req.upgrade);
          return await ctx.upgrade(upgrade) as T;
        });
      }
    }
    return solutions.length > 0 ? solutions : null;
  }

  async check(_requirements: R, _context: T) {
    return; // XXX
  }
}