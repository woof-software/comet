import { expect } from 'chai';
import { Constraint, World } from '../../plugins/scenario/index.js';
import { CometContext } from '../context/CometContext.js';
import { Requirements } from './Requirements.js';

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
