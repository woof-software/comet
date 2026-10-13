import { expect } from 'chai';
import type { Constraint, World } from '../../plugins/scenario';
import type { CometContext } from '../context/CometContext';
import type { Requirements } from './Requirements';

export class FilterConstraint<T extends CometContext, R extends Requirements> implements Constraint<T, R> {
  async solve(requirements: R, context: T) {
    const filterFn = requirements.filter;
    if (!filterFn) {
      return null;
    }

    if (await filterFn(context)) {
      return null;
    } else {
      return []; // filter out this solution
    }
  }

  async check(requirements: R, context: T, _world: World) {
    const filterFn = requirements.filter;
    if (!filterFn) {
      return;
    }

    expect(await filterFn(context)).to.be.equals(true);
  }
}
