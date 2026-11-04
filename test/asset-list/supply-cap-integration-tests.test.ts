import { ethers, expect, takeSnapshot, SnapshotRestorer } from '../helpers';
import { CometInterface, Configurator, FaucetToken } from '../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ASSET_DECIMALS, deployAssetListFixture } from './shared';

// The supply cap applies to collateral only, so one market is enough. Its collaterals with 6, 8 and 18 decimals are
// supplied against caps set through Configurator.updateAssetSupplyCap, which updates the stored config and the asset
// list in one call, so the Comet reads the new cap with no redeploy.
describe('supply cap integration', function () {
  const MAX_UINT128 = 2n ** 128n - 1n;
  const COLLATERAL_DECIMALS = [6, 8, 18];

  let configurator: Configurator;
  let comet: CometInterface;
  let governor: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let snapshot: SnapshotRestorer;

  before(async () => {
    let users: SignerWithAddress[];
    ({ configurator, comet, governor, users } = await deployAssetListFixture());
    [alice, bob] = users;

    snapshot = await takeSnapshot();
  });

  after(async () => await snapshot.restore());

  for (const decimals of COLLATERAL_DECIMALS) {
    describe(`collateral with ${decimals} decimals`, function () {
      const oneToken = 10n ** BigInt(decimals);
      let token: FaucetToken;

      before(async () => {
        const asset = (await configurator.getAssetConfigs(comet.address))[ASSET_DECIMALS.indexOf(decimals)].asset;
        token = await ethers.getContractAt('FaucetToken', asset) as FaucetToken;
      });

      const SUPPLY_CAPS = [
        { name: '1 wei cap', supplyCap: 1n },
        { name: 'cap one wei below a whole token', supplyCap: oneToken - 1n },
        { name: '0.5 token cap', supplyCap: oneToken / 2n },
        { name: '10.5 token cap', supplyCap: oneToken * 21n / 2n },
        { name: 'uint128 max cap', supplyCap: MAX_UINT128 },
        { name: 'zero cap', supplyCap: 0n },
      ];

      // The zero cap, last in the list, has no amount below it. For the 1 wei cap the amount below is 0: a zero amount
      // has no check of its own, so supplying it succeeds
      context('amount below the cap', function () {
        for (const { name, supplyCap } of SUPPLY_CAPS.slice(0, -1)) {
          context(name, function () {
            const amount = supplyCap - 1n;

            before(async () => {
              await snapshot.restore();
              await token.allocateTo(alice.address, amount);
              await token.connect(alice).approve(comet.address, amount);
            });

            it('sets the supply cap', async () => {
              await configurator.connect(governor).updateAssetSupplyCap(comet.address, token.address, supplyCap);
            });

            it('supplies the amount', async () => {
              await comet.connect(alice).supply(token.address, amount);
            });

            it('stores the user collateral balance', async () => {
              expect(await comet.collateralBalanceOf(alice.address, token.address)).to.equal(amount);
            });

            it('stores the total supply', async () => {
              expect((await comet.totalsCollateral(token.address)).totalSupplyAsset).to.equal(amount);
            });
          });
        }
      });

      context('amount equal to the cap', function () {
        for (const { name, supplyCap } of SUPPLY_CAPS) {
          context(name, function () {
            const amount = supplyCap;

            before(async () => {
              await snapshot.restore();
              await token.allocateTo(alice.address, amount);
              await token.connect(alice).approve(comet.address, amount);
            });

            it('sets the supply cap', async () => {
              await configurator.connect(governor).updateAssetSupplyCap(comet.address, token.address, supplyCap);
            });

            it('supplies the amount', async () => {
              await comet.connect(alice).supply(token.address, amount);
            });

            it('stores the user collateral balance', async () => {
              expect(await comet.collateralBalanceOf(alice.address, token.address)).to.equal(amount);
            });

            it('stores the total supply', async () => {
              expect((await comet.totalsCollateral(token.address)).totalSupplyAsset).to.equal(amount);
            });
          });
        }
      });

      context('amount above the cap', function () {
        for (const { name, supplyCap } of SUPPLY_CAPS) {
          context(name, function () {
            const amount = supplyCap + 1n;
            // At uint128 max the amount above does not fit the uint128 the Comet keeps it in, so it fails that cast first
            const error = supplyCap === MAX_UINT128 ? 'InvalidUInt128' : 'SupplyCapExceeded';

            before(async () => {
              await snapshot.restore();
              await token.allocateTo(alice.address, amount);
              await token.connect(alice).approve(comet.address, amount);
            });

            it('sets the supply cap', async () => {
              await configurator.connect(governor).updateAssetSupplyCap(comet.address, token.address, supplyCap);
            });

            it(`reverts with ${error}`, async () => {
              await expect(comet.connect(alice).supply(token.address, amount)).to.be.revertedWithCustomError(comet, error);
            });

            it('leaves the user collateral balance at zero', async () => {
              expect(await comet.collateralBalanceOf(alice.address, token.address)).to.equal(0);
            });

            it('leaves the total supply at zero', async () => {
              expect((await comet.totalsCollateral(token.address)).totalSupplyAsset).to.equal(0);
            });
          });
        }
      });

      // The cap limits the total supplied by everyone, not each supplier's own amount
      context('cumulative supply', function () {
        const supplyCap = oneToken * 21n / 2n;
        const aliceAmount = oneToken * 5n;
        const bobAmount = supplyCap - aliceAmount;

        before(async () => {
          await snapshot.restore();
          for (const [user, amount] of [[alice, aliceAmount], [bob, bobAmount]] as const) {
            await token.allocateTo(user.address, amount + 1n);
            await token.connect(user).approve(comet.address, amount + 1n);
          }
        });

        it('sets the supply cap', async () => {
          await configurator.connect(governor).updateAssetSupplyCap(comet.address, token.address, supplyCap);
        });

        it('supplies the first supplier amount', async () => {
          await comet.connect(alice).supply(token.address, aliceAmount);
        });

        it('supplies the second supplier amount', async () => {
          await comet.connect(bob).supply(token.address, bobAmount);
        });

        it('reaches the cap together', async () => {
          expect((await comet.totalsCollateral(token.address)).totalSupplyAsset).to.equal(supplyCap);
        });

        it('reverts on one more wei from either supplier', async () => {
          for (const user of [alice, bob]) {
            await expect(comet.connect(user).supply(token.address, 1n)).to.be.revertedWithCustomError(comet, 'SupplyCapExceeded');
          }
        });
      });

      // Lowering the cap below what is already supplied blocks new supply but never traps existing collateral
      context('cap lowered below the current total supply', function () {
        const supplied = oneToken * 21n / 2n;

        before(async () => {
          await snapshot.restore();
          await token.allocateTo(alice.address, supplied);
          await token.connect(alice).approve(comet.address, supplied);
        });

        it('sets the supply cap', async () => {
          await configurator.connect(governor).updateAssetSupplyCap(comet.address, token.address, supplied);
        });

        it('supplies up to the cap', async () => {
          await comet.connect(alice).supply(token.address, supplied);
        });

        it('lowers the supply cap below the total supply', async () => {
          await configurator.connect(governor).updateAssetSupplyCap(comet.address, token.address, oneToken);
        });

        it('reverts on any further supply', async () => {
          await token.allocateTo(bob.address, 1n);
          await token.connect(bob).approve(comet.address, 1n);
          await expect(comet.connect(bob).supply(token.address, 1n)).to.be.revertedWithCustomError(comet, 'SupplyCapExceeded');
        });

        it('lets the existing collateral be withdrawn', async () => {
          await comet.connect(alice).withdraw(token.address, supplied);
          expect(await token.balanceOf(alice.address)).to.equal(supplied);
        });

        it('leaves the user collateral balance at zero', async () => {
          expect(await comet.collateralBalanceOf(alice.address, token.address)).to.equal(0);
        });

        it('leaves the total supply at zero', async () => {
          expect((await comet.totalsCollateral(token.address)).totalSupplyAsset).to.equal(0);
        });
      });
    });
  }
});
