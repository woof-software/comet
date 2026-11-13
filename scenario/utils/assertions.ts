import { expect } from 'chai';
import { BigNumber, ContractReceipt, ContractTransaction, utils } from 'ethers';
import { abs } from './math';

export function expectApproximately (
  expected: bigint,
  actual: bigint,
  precision = 0n
) {
  expect(BigNumber.from(abs(expected - actual))).to.be.lte(
    BigNumber.from(precision)
  );
}

export function expectBase(expected: bigint, actual: bigint, precision = 2n) {
  expectApproximately(expected, actual, precision);
}

export function expectRevertCustom(
  tx: Promise<ContractReceipt | ContractTransaction>,
  custom: string
) {
  return tx
    .then((_) => {
      throw new Error('Expected transaction to be reverted');
    })
    .catch((e) => {
      const selector = utils
        .keccak256(
          custom
            .split('')
            .reduce((a, s) => a + s.charCodeAt(0).toString(16), '0x')
        )
        .slice(2, 2 + 8);
      const errorName = custom.replace(/\(\)$/, '');
      const escaped = custom.replace(/[()]/g, '\\$&');

      // ethers sometimes decodes the error (CALL_EXCEPTION), sometimes only the selector
      if (
        e.errorName === errorName ||
        e.errorSignature === custom ||
        e.data === `0x${selector}`
      ) {
        return;
      }

      const patterns = [
        new RegExp(`custom error '${escaped}'`),
        new RegExp(`unrecognized custom error with selector ${selector}`),
        new RegExp(
          `unrecognized custom error \\(return data: 0x${selector}\\)`
        ),
        new RegExp(`errorSignature="${escaped}"`),
        new RegExp(`errorName="${errorName}"`),
        new RegExp(`data="0x${selector}"`),
      ];
      for (const pattern of patterns)
        if (pattern.test(e.message) || pattern.test(e.reason)) return;
      throw new Error(
        `Expected revert message in one of [${patterns}], but reverted with: ${e.message}`
      );
    });
}

export function expectRevertMatches(
  tx: Promise<ContractReceipt>,
  patterns: RegExp[]
) {
  return tx
    .then((_) => {
      throw new Error('Expected transaction to be reverted');
    })
    .catch((e) => {
      for (const pattern of patterns) if (pattern.test(e.message)) return;
      throw new Error(
        `Expected revert message in one of ${patterns}, but reverted with: ${e.message}`
      );
    });
}
