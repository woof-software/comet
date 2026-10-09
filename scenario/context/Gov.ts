import type { BigNumberish } from 'ethers';

export type { BaseBridgeReceiver, IGovernorBravo } from '../../build/types/index.js';

export enum ProposalState {
  Pending,
  Active,
  Canceled,
  Defeated,
  Succeeded,
  Queued,
  Expired,
  Executed
}

export enum BridgedProposalState {
  Queued,
  Expired,
  Executed
}

export type OpenProposal = {
  id: bigint;
  proposer: string;
  targets: string[];
  values: BigNumberish[];
  signatures: string[];
  calldatas: string[];
  startBlock: bigint;
  endBlock: bigint;
};
export type OpenBridgedProposal = { id: bigint, eta: bigint };
