// NB: this couples this plugin to deployment manager plugin
import { DeploymentManager } from '../deployment_manager/DeploymentManager.js';
import type { ExtendedNonceManager } from '../deployment_manager/NonceManager.js';
import { getHardhatEthers } from '../deployment_manager/hardhat3/runtime.js';
import hreForBase from './utils/hreForBase.js';
import { impersonateAddress } from './utils/index.js';

export type ForkSpec = {
  name: string;
  network: string;
  deployment: string;
  blockNumber?: number;
  allocation?: number;
  auxiliaryBase?: string;
};

export type Snapshot = {
  snapshot: string;
  auxiliarySnapshot?: string;
}

export class World {
  base: ForkSpec;
  deploymentManager: DeploymentManager;
  snapshotDeploymentManager: DeploymentManager;

  auxiliaryDeploymentManager?: DeploymentManager;
  snapshotAuxiliaryDeploymentManager?: DeploymentManager;

  constructor(base: ForkSpec) {
    this.base = base;
  }

  async initialize(base: ForkSpec) {
    const hre = await hreForBase(base);
    this.deploymentManager = new DeploymentManager(base.network, base.deployment, hre);
    // Q: should we really need to fork/snapshot the deployment manager?
    this.snapshotDeploymentManager = this.deploymentManager;
    if (this.base.auxiliaryBase) {
      const auxiliaryBase = hre.config.scenario.bases.find(b => b.name === this.base.auxiliaryBase);
      this.auxiliaryDeploymentManager = new DeploymentManager(auxiliaryBase.network, auxiliaryBase.deployment, await hreForBase(auxiliaryBase));
      this.snapshotAuxiliaryDeploymentManager = this.auxiliaryDeploymentManager;
    }
    const { provider } = await getHardhatEthers(this.deploymentManager.hre);
    await provider.send('evm_mine', []);
  }

  isRemoteFork(): boolean {
    return this.base.network !== 'hardhat';
  }

  async _snapshot(): Promise<Snapshot> {
    this.snapshotDeploymentManager = this.deploymentManager.fork();
    const { provider } = await getHardhatEthers(this.deploymentManager.hre);
    const snapshot = await provider.send('evm_snapshot', []) as string;
    let auxiliarySnapshot: string;
    if (this.auxiliaryDeploymentManager) {
      this.snapshotAuxiliaryDeploymentManager = this.auxiliaryDeploymentManager.fork();
      const auxiliaryEthers = await getHardhatEthers(this.auxiliaryDeploymentManager.hre);
      auxiliarySnapshot = await auxiliaryEthers.provider.send('evm_snapshot', []) as string;
    }
    return { snapshot, auxiliarySnapshot };
  }

  async _revert(snapshot: Snapshot) {
    this.deploymentManager = this.snapshotDeploymentManager;
    const { provider } = await getHardhatEthers(this.deploymentManager.hre);
    await provider.send('evm_revert', [snapshot.snapshot]);

    if (this.auxiliaryDeploymentManager) {
      this.auxiliaryDeploymentManager = this.snapshotAuxiliaryDeploymentManager;
      const auxiliaryEthers = await getHardhatEthers(this.auxiliaryDeploymentManager.hre);
      await auxiliaryEthers.provider.send('evm_revert', [snapshot.auxiliarySnapshot]);
    }
  }

  async _revertAndSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    await this._revert(snapshot);
    return await this._snapshot();
  }

  async impersonateAddress(address: string, opts?: { value?: bigint, onGovNetwork?: boolean }): Promise<ExtendedNonceManager> {
    const options = opts ?? {};
    const dm = options.onGovNetwork ? this.auxiliaryDeploymentManager ?? this.deploymentManager : this.deploymentManager;
    return await impersonateAddress(dm, address, options.value);
  }

  async timestamp() {
    const { provider } = await getHardhatEthers(this.deploymentManager.hre);
    const blockNumber = await provider.getBlockNumber();
    const block = await provider.getBlock(blockNumber);
    if (block === null) throw new Error(`Cannot load block ${blockNumber}`);
    return block.timestamp;
  }

  async increaseTime(amount: number) {
    const { provider } = await getHardhatEthers(this.deploymentManager.hre);
    await provider.send('evm_increaseTime', [amount]);
    await provider.send('evm_mine', []); // ensure block is mined
  }

  async chainId() {
    const { provider } = await getHardhatEthers(this.deploymentManager.hre);
    return (await provider.getNetwork()).chainId;
  }
}
