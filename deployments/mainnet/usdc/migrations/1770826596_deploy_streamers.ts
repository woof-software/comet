import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { BigNumber, Contract, utils } from 'ethers';

const USDC_VAULT = '0x8624f61cc6e5a86790e173712afdd480fa8b73ba';
const USDC_RESERVE_VAULT = '0x3D6eEf6A92b15361697698695334E98C5db91D6b';

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

const CONSTANTS_PRICE_FEED = '0xD72ac1bCE9177CFe7aEb5d0516a38c88a64cE0AB';

const STREAMER_FACTORY = '0xFB9167A8b5Cb585202953c6d5537A7D640c43a96';

const MAX_REMOVE_FROM_USDC_VAULT = utils.parseUnits('1788800', 6);

const STREAMER_PARAMS = {
  WOOF: {
    streamer: '0xF088339DD8e79819A41aDD5FFB75d9F245AfaAb1',
    recipient: '0xd36025E1e77069aA991DC24f0E6287b4A35c89Ad',
    remainingStreamAmount: utils.parseUnits('464283.0416', 6),
    remainingStreamTime: BigNumber.from(7887439),
  },
  SSP: {
    streamer: '0x334791289a906Ac8f96ac0f90E7A91Bf4AaE4A60',
    recipient: '0xa1fa21665daA59f27046110CC2f58218b6343A2B',
    remainingStreamAmount: utils.parseUnits('759218.3771', 6),
    remainingStreamTime: BigNumber.from(15024739),
  },
  ZERO_SHADOW: {
    streamer: '0xAF9CEE006AE377e88f3BBd668e3d67807F546Bd8',
    recipient: '0x9FAEaBCeD4C29F030d40A83F1a7822624d67f904',
    remainingStreamAmount: utils.parseUnits('109083.5419', 6),
    remainingStreamTime: BigNumber.from(15024739),
  },
  TALLY: {
    streamer: '0x36a0eB84154797DAdCEaCFD046785dB31094C308',
    recipient: '0x7E90E03654732ABedF89Faf87f05BcD03ACEeFdC',
    remainingStreamAmount: utils.parseUnits('62527.0873', 6),
    remainingStreamTime: BigNumber.from(13459339),
  },
  GAUNTLET: {
    streamer: '0xEA2B6BC719CF6D2Fed07865d26987D32d570DbBD',
    recipient: '0xD20c9667bf0047F313228F9fE11F8b9F8Dc29bBa',
    remainingStreamAmount: utils.parseUnits('813373.3687', 6),
    remainingStreamTime: BigNumber.from(18828559),
  }
};

let woofStreamer: string;
let sspStreamer: string;
let zeroShadowStreamer: string;
let tallyStreamer: string;
let gauntletStreamer: string;

async function deployStreamer(deploymentManager: DeploymentManager, recipient: string, remainingStreamAmount: BigNumber, remainingStreamTime: BigNumber) {
  const streamerFactoryContract = new Contract(
    STREAMER_FACTORY, [
      'function deployStreamer(address _streamingAsset,address _nativeAsset,address _streamingAssetOracle,address _nativeAssetOracle,address _returnAddress,address _streamCreator,address _recipient,uint256 _nativeAssetStreamingAmount,uint256 _slippage,uint256 _claimCooldown,uint256 _sweepCooldown,uint256 _streamDuration,uint256 _minimumNoticePeriod)'
    ],
    await deploymentManager.getSigner()
  );
  const {timelock} = await deploymentManager.getContracts();

  const tx = await streamerFactoryContract.deployStreamer(
    USDC_ADDRESS,
    USDT_ADDRESS,
    CONSTANTS_PRICE_FEED,
    CONSTANTS_PRICE_FEED,
    timelock.address,
    timelock.address,
    recipient,
    remainingStreamAmount,
    0,
    604800,
    864000,
    remainingStreamTime,
    5184000
  );
  const receipt = await tx.wait();
  const deployArgs = {
    _streamingAsset: USDC_ADDRESS,
    _nativeAsset: USDT_ADDRESS,
    _streamingAssetOracle: CONSTANTS_PRICE_FEED,
    _nativeAssetOracle: CONSTANTS_PRICE_FEED,
    _returnAddress: recipient,
    _streamCreator: recipient,
    _recipient: recipient,
    _nativeAssetStreamingAmount: remainingStreamAmount,
    _slippage: 0,
    _claimCooldown: 604800,
    _sweepCooldown: 864000,
    _streamDuration: remainingStreamTime,
    _minimumNoticePeriod: 5184000
  };
  console.log('Deployed streamer with args: ', deployArgs);
  console.log('Streamer address: ', '0x' + receipt.events[0].data.slice(26, 66)); // first 66 characters of data field is the address
  return '0x' + receipt.events[0].data.slice(26, 66);
}

export default migration('1770826596_deploy_streamers', {
  async prepare(deploymentManager: DeploymentManager) {

    const woofParams = STREAMER_PARAMS.WOOF;
    const sspParams = STREAMER_PARAMS.SSP;
    const zeroShadowParams = STREAMER_PARAMS.ZERO_SHADOW;
    const tallyParams = STREAMER_PARAMS.TALLY;
    const gauntletParams = STREAMER_PARAMS.GAUNTLET;
    console.log('WOOF:');
    woofStreamer = await deployStreamer(deploymentManager, woofParams.recipient, woofParams.remainingStreamAmount, woofParams.remainingStreamTime);
    console.log('SSP:');
    sspStreamer = await deployStreamer(deploymentManager, sspParams.recipient, sspParams.remainingStreamAmount, sspParams.remainingStreamTime);
    console.log('Zero Shadow:');
    zeroShadowStreamer = await deployStreamer(deploymentManager, zeroShadowParams.recipient, zeroShadowParams.remainingStreamAmount, zeroShadowParams.remainingStreamTime);
    console.log('Tally:');
    tallyStreamer = await deployStreamer(deploymentManager, tallyParams.recipient, tallyParams.remainingStreamAmount, tallyParams.remainingStreamTime);
    console.log('Gauntlet:');
    gauntletStreamer = await deployStreamer(deploymentManager, gauntletParams.recipient, gauntletParams.remainingStreamAmount, gauntletParams.remainingStreamTime);
    return {
      woofStreamer,
      sspStreamer,
      zeroShadowStreamer,
      tallyStreamer,
      gauntletStreamer
    };
  },

  async enact(
    deploymentManager: DeploymentManager,
    _,
    {woofStreamer, sspStreamer, zeroShadowStreamer, tallyStreamer, gauntletStreamer}
  ) {
    const trace = deploymentManager.tracer();

    const {
      governor,
      timelock,
      comet
    } = await deploymentManager.getContracts();
    
    const woofParams = STREAMER_PARAMS.WOOF;
    const sspParams = STREAMER_PARAMS.SSP;
    const zeroShadowParams = STREAMER_PARAMS.ZERO_SHADOW;
    const tallyParams = STREAMER_PARAMS.TALLY;
    const gauntletParams = STREAMER_PARAMS.GAUNTLET;

    // console.log('WOOF:');
    // woofStreamer = await deployStreamer(deploymentManager, woofParams.recipient, woofParams.remainingStreamAmount, woofParams.remainingStreamTime);
    // console.log('SSP:');
    // sspStreamer = await deployStreamer(deploymentManager, sspParams.recipient, sspParams.remainingStreamAmount, sspParams.remainingStreamTime);
    // console.log('Zero Shadow:');
    // zeroShadowStreamer = await deployStreamer(deploymentManager, zeroShadowParams.recipient, zeroShadowParams.remainingStreamAmount, zeroShadowParams.remainingStreamTime);
    // console.log('Tally:');
    // tallyStreamer = await deployStreamer(deploymentManager, tallyParams.recipient, tallyParams.remainingStreamAmount, tallyParams.remainingStreamTime);
    // console.log('Gauntlet:');
    // gauntletStreamer = await deployStreamer(deploymentManager, gauntletParams.recipient, gauntletParams.remainingStreamAmount, gauntletParams.remainingStreamTime);

    const totalSumForAllStreamers = woofParams.remainingStreamAmount
      .add(sspParams.remainingStreamAmount)
      .add(zeroShadowParams.remainingStreamAmount)
      .add(tallyParams.remainingStreamAmount)
      .add(gauntletParams.remainingStreamAmount);
    console.log('Total amount for all streamers: ', totalSumForAllStreamers.toString());
    const amountToWithdrawFromVault = totalSumForAllStreamers.gt(MAX_REMOVE_FROM_USDC_VAULT) ? MAX_REMOVE_FROM_USDC_VAULT : totalSumForAllStreamers;
    const withdrawCalldataUSDCVault = comet.interface.encodeFunctionData('withdrawTo', [timelock.address, USDC_ADDRESS, amountToWithdrawFromVault]);
    console.log('Amount to withdraw from USDC Vault: ', amountToWithdrawFromVault.toString());
    const amountToWithdrawFromReserveVault = totalSumForAllStreamers.sub(amountToWithdrawFromVault);
    const withdrawCalldataUSDCReserveVault = comet.interface.encodeFunctionData('withdrawTo', [timelock.address, USDC_ADDRESS, amountToWithdrawFromReserveVault]);
    console.log('Amount to withdraw from USDC Reserve Vault: ', amountToWithdrawFromReserveVault.toString());

    const mainnetActions = [
      {
        target: woofParams.streamer,
        signature: 'sweepRemaining()',
        calldata: '0x',
      },
      {
        target: sspParams.streamer,
        signature: 'terminateStream(uint256)',
        calldata: utils.defaultAbiCoder.encode(['uint256'], [0]),
      },
      {
        target: zeroShadowParams.streamer,
        signature: 'terminateStream(uint256)',
        calldata: utils.defaultAbiCoder.encode(['uint256'], [0]),
      },
      {
        target: tallyParams.streamer,
        signature: 'terminateStream(uint256)',
        calldata: utils.defaultAbiCoder.encode(['uint256'], [0]),
      },
      {
        target: gauntletParams.streamer,
        signature: 'terminateStream(uint256)',
        calldata: utils.defaultAbiCoder.encode(['uint256'], [0]),
      },
      {
        target: USDC_VAULT,
        signature: 'execute((address,uint256,bytes))',
        calldata: utils.defaultAbiCoder.encode(['(address,uint256,bytes)'], [[comet.address, 0, withdrawCalldataUSDCVault]]),
      },
      {
        target: USDC_RESERVE_VAULT,
        signature: 'execute((address,uint256,bytes))',
        calldata: utils.defaultAbiCoder.encode(['(address,uint256,bytes)'], [[comet.address, 0, withdrawCalldataUSDCReserveVault]]),
      },
      // WOOF
      {
        target: USDC_ADDRESS,
        signature: 'transfer(address,uint256)',
        calldata: utils.defaultAbiCoder.encode(['address','uint256'], [woofStreamer, woofParams.remainingStreamAmount]),
      },
      {
        target: woofStreamer,
        signature: 'initialize()',
        calldata: '0x',
      },
      // SSP
      {
        target: USDC_ADDRESS,
        signature: 'transfer(address,uint256)',
        calldata: utils.defaultAbiCoder.encode(['address','uint256'], [sspStreamer, sspParams.remainingStreamAmount]),
      },
      {
        target: sspStreamer,
        signature: 'initialize()',
        calldata: '0x',
      },
      // Zero Shadow
      {
        target: USDC_ADDRESS,
        signature: 'transfer(address,uint256)',
        calldata: utils.defaultAbiCoder.encode(['address','uint256'], [zeroShadowStreamer, zeroShadowParams.remainingStreamAmount]),
      },
      {
        target: zeroShadowStreamer,
        signature: 'initialize()',
        calldata: '0x',
      },
      // Tally
      {
        target: USDC_ADDRESS,
        signature: 'transfer(address,uint256)',
        calldata: utils.defaultAbiCoder.encode(['address','uint256'], [tallyStreamer, tallyParams.remainingStreamAmount]),
      },
      {
        target: tallyStreamer,
        signature: 'initialize()',
        calldata: '0x',
      },
      // Gauntlet
      {
        target: USDC_ADDRESS,
        signature: 'transfer(address,uint256)',
        calldata: utils.defaultAbiCoder.encode(['address','uint256'], [gauntletStreamer, gauntletParams.remainingStreamAmount]),
      },
      {
        target: gauntletStreamer,
        signature: 'initialize()',
        calldata: '0x',
      },
    ];
    const description = `# Service Providers Stream Revision

*Following the community discussion in [Service Providers Stream Revision](https://www.comp.xyz/t/service-providers-stream-revision/7622), this post presents the formal on-chain proposal with exact figures.*

## Summary

This proposal migrates all active Compound service provider streams from COMP to USDC, covering Risk Management, Security Services, Development, and Governance workstreams. New USDC streams will be created to fulfill remaining obligations for each vendor without further drawing down COMP reserves.

## Current Stream Balances

*Snapshot taken at 2026-02-23T21:08:16.000Z*

| Service Provider | Claimed to Date (USD) | Remaining Stream Balance (COMP) | Governance Pipeline (days) | Termination Period (days) | Stream Runway (days) |
| ----- | ----- | ----- | :---: | :---: | :---: |
| Woof Software | $ 1,471,298.3257 | 7,889.46 | 6.5 | 0 | 24.76 |
| SSP | $ 872,464.2314 | 8,451.24 | 6.5 | 60 | 30.16 |
| ZeroShadow | $ 112,235.8257 | 2,048.62 | 6.5 | 60 | 51.17 |
| Tally | $ 76,098.0594 | 812.49 | 6.5 | 30 | 33.82 |
| Gauntlet | $ 609,124.0183 | 13,393.04 | 6.5 | 60 | 51.95 |

**Definitions:**

- **Governance Pipeline** — Minimum days required for an on-chain proposal to pass (6.5 days).  
- **Termination Period** — Days required to sweep a stream balance after cancellation, per each provider's agreement.  
- **Stream Runway** — Days until the remaining COMP stream balance is fully claimed at the current COMP price.

## Stream Deficit Analysis

The table above shows that all streams, except Woof have a runway longer than the combined governance pipeline \+ termination period. This means that in the time required to pass and execute this proposal, providers will continue claiming COMP and their stream balances may be partially or fully depleted before the sweep occurs.

To conservatively estimate the remaining claimable COMP value, we assume an average COMP price of **$14** over the next **66.5 days** (governance pipeline \+ maximum termination period).

| Service Provider | Remaining Balance (COMP) | Assumed COMP Price | Total USD Value at $14 | Claimed to Date (USD) | Time to Termination (days) | COMP Claimed by Termination (USD at $14) | Estimated Deficit (USD) |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| Woof Software | 7,889.46 | $14 | $ 110,452.3879 | $ 1,471,298.3257 | 6.5 | $ 64,418.6327 | $ 464,283.0416 |
| SSP | 8,451.24 | $14 | $ 118,317.3916 | $ 872,464.2314 | 66.5 | $ 118,317.3916 | $ 759,218.3771 |
| ZeroShadow | 2,048.62 | $14 | $ 28,680.6323 | $ 112,235.8257 | 66.5 | $ 28,680.6323 | $ 109,083.5419 |
| Tally | 812.49 | $14 | $ 11,374.8534 | $ 76,098.0594 | 36.5 | $ 11,374.8534 | $ 62,527.0873 |
| Gauntlet | 13,393.04 | $14 | $ 187,502.6130 | $ 609,124.0183 | 66.5 | $ 187,502.6130 | $ 813,373.3687 |

**Total estimated deficit across all streams: 2,208,485.4166 USDC**

The deficit represents the gap between the USD value each provider is owed under their mandate and what they will have received by the time existing streams are terminated and swept.

\[[Detailed calculations](https://docs.google.com/spreadsheets/d/1QVdpxSbFP5p83aoSaGBsO2M_kYE8NIMxthqSiFBFL3Q/edit?gid=0#gid=0)\]

## New USDC Streams

To cover the deficit, this proposal creates five new USDC streams — one per service provider. Funding will be sourced primarily from the [Aera Vendor Vault](https://app.aera.finance/vaults/eth:0x8624f61cc6e5a86790e173712afdd480fa8b73ba), with a supplemental draw from the [Aera Reserves Vault](https://app.aera.finance/vaults/eth:0x3d6eef6a92b15361697698695334e98c5db91d6b) as needed.

| Service Provider | Recipient Address | USDC Stream Amount |
| :---- | :---- | :---- |
| Woof Software | 0x72bf2d7b05152ef282805f3e38752c436d94e4af | $ 464,283.0416 |
| SSP | 0xba3cdb9d5c2119137126989f81edaea8b50331d2 | $ 759,218.3771 |
| ZeroShadow | 0xe9c21ebc3815cdfbe07f721126d3cb46407fd79a | $ 109,083.5419 |
| Tally | 0x96a0029c945898de1072ea8f33aa88b7fde3b125 | $ 62,527.0873 |
| Gauntlet | 0x12875aed495cd573433f0c93d538c0ccc9e2b8fa | $ 813,373.3687 |

## Surplus Reconciliation

Because this proposal uses estimated values — including the assumed $14 average COMP price and variable governance timeline — the USDC streams are intentionally sized slightly above the minimum required to avoid any shortfall. Once all COMP streams are fully terminated and swept, Woof Software will publish a final reconciliation report and coordinate with each service provider to return any surplus USDC to the Compound Timelock.

## On-Chain Actions

This proposal will execute the following:

1. Cancel all active COMP streams to the five service providers  
2. Withdraw USDC from the Aera Vendor and Aera Reserves Vaults  
3. Fund new USDC streams for each service provider based on the deficit amounts above
`;
    console.log('proposal: ', await proposal(mainnetActions, description));
    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      ), 0, 300_000
    );

    const event = txn.events.find(
      (event: { event: string }) => event.event === 'ProposalCreated'
    );
    const [proposalId] = event.args;
    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return false;
  },

  async verify(deploymentManager: DeploymentManager) {
    const woofStreamerContract = new Contract(woofStreamer, ['function recipient() view returns (address)'], await deploymentManager.getSigner());
    const sspStreamerContract = new Contract(sspStreamer, ['function recipient() view returns (address)'], await deploymentManager.getSigner());
    const zeroShadowStreamerContract = new Contract(zeroShadowStreamer, ['function recipient() view returns (address)'], await deploymentManager.getSigner());
    const tallyStreamerContract = new Contract(tallyStreamer, ['function recipient() view returns (address)'], await deploymentManager.getSigner());
    const gauntletStreamerContract = new Contract(gauntletStreamer, ['function recipient() view returns (address)'], await deploymentManager.getSigner());

    const USDC = new Contract(USDC_ADDRESS, ['function balanceOf(address) view returns (uint256)'], await deploymentManager.getSigner());

    const woofParams = STREAMER_PARAMS.WOOF;
    const sspParams = STREAMER_PARAMS.SSP;
    const zeroShadowParams = STREAMER_PARAMS.ZERO_SHADOW;
    const tallyParams = STREAMER_PARAMS.TALLY;
    const gauntletParams = STREAMER_PARAMS.GAUNTLET;

    expect(await woofStreamerContract.recipient()).to.equal(woofParams.recipient);
    expect(await sspStreamerContract.recipient()).to.equal(sspParams.recipient);
    expect(await zeroShadowStreamerContract.recipient()).to.equal(zeroShadowParams.recipient);
    expect(await tallyStreamerContract.recipient()).to.equal(tallyParams.recipient);
    expect(await gauntletStreamerContract.recipient()).to.equal(gauntletParams.recipient);

    expect(await USDC.balanceOf(woofStreamer)).to.equal(woofParams.remainingStreamAmount);
    expect(await USDC.balanceOf(sspStreamer)).to.equal(sspParams.remainingStreamAmount);
    expect(await USDC.balanceOf(zeroShadowStreamer)).to.equal(zeroShadowParams.remainingStreamAmount);
    expect(await USDC.balanceOf(tallyStreamer)).to.equal(tallyParams.remainingStreamAmount);
    expect(await USDC.balanceOf(gauntletStreamer)).to.equal(gauntletParams.remainingStreamAmount);

    expect(false).to.be.true;
  },
});
