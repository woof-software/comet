import { BigNumber, BigNumberish } from 'ethers';

export { BaseBridgeReceiver, IGovernorBravo } from '../../build/types';

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
  id: BigNumber;
  proposer: string;
  targets: string[];
  values: BigNumberish[];
  signatures: string[];
  calldatas: string[];
  startBlock: BigNumber;
  endBlock: BigNumber;
};
export type OpenBridgedProposal = { id: BigNumber, eta: BigNumber };
