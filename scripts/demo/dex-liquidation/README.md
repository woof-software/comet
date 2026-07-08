# Partial Liquidation V1 — local demo

How to run the DEX‑liquidation demo on a local forked‑mainnet Hardhat node. The deploy stands up a **USDC** Comet
with a **WETH + WBTC + LINK + UNI** collateral set, a 1inch/Uniswap DEX adapter and a liquidation module. Prices
are mock feeds (so they can be crashed on demand); the tokens are real fork tokens (so 1inch/Uniswap can actually
swap). The scenario scripts fund the actors, borrow, crash prices and liquidate, printing the borrower's
collateral, debt and health factor at each step.

Actors are Hardhat signers: `signers[0]` = deployer + admin, `signers[1]` = lender, `signers[2]` = borrower.
The scripts read the Comet address from `roots.json` (written by the deploy).

Requires `MAINNET_QUICKNODE_LINK`; the 1inch cases (04a, 04e) also need `ONEINCH_API_KEY`.

## 0. Start a forked node
```bash
npx hardhat node --fork $MAINNET_QUICKNODE_LINK
```

## 1. Deploy the market
Run deployment for DEX partial liquidation.
```bash
npx hardhat run deployments/localhost/usdc-dex/deploy.ts --network localhost
```

## 2. Single‑collateral scenarios
Set up a WETH‑only position and make it liquidatable:
```bash
npx hardhat run scripts/demo/02-supply-and-borrow.ts --network localhost   # lender lends USDC; borrower deposits WETH & borrows
npx hardhat run scripts/demo/03-drop-price.ts        --network localhost   # crash WETH to $1300 → liquidatable
```
Then run any of the cases. Each snapshots on entry and reverts on exit, so you can run them back‑to‑back:
```bash
npx hardhat run scripts/demo/dex-liquidation/04a-liquidate-via-1inch.ts    --network localhost   # partial, sold on 1inch
npx hardhat run scripts/demo/dex-liquidation/04b-liquidate-via-uniswap.ts  --network localhost   # partial, sold on Uniswap
npx hardhat run scripts/demo/dex-liquidation/04c-absorb-dex-inoperable.ts  --network localhost   # no WETH swap route → absorbed
npx hardhat run scripts/demo/dex-liquidation/04d-absorb-deactivated.ts     --network localhost   # WETH deactivated → liquidated
npx hardhat run scripts/demo/dex-liquidation/04f-full-liquidation.ts       --network localhost   # partial disabled → full balance seized
```

## 3. Re‑run the node for the multi‑collateral flow
The single‑collateral run leaves a position on the node, so start from a clean state: stop the node (Ctrl‑C in
the step‑0 terminal) and repeat steps 0 and 1.
```bash
# terminal A — restart the node:
npx hardhat node --fork $MAINNET_QUICKNODE_LINK
# terminal B — redeploy:
npx hardhat run deployments/localhost/usdc-dex/deploy.ts --network localhost
```

## 4. Multi‑collateral scenario
Set up a WETH + WBTC + LINK + UNI position and drop several prices so it's liquidatable but still a partial
liquidation:
```bash
npx hardhat run scripts/demo/02a-supply-and-borrow-multi.ts --network localhost   # deposits all 4 collaterals & borrows
WETH_PRICE=1250 WBTC_PRICE=47000 LINK_PRICE=8 UNI_PRICE=6 \
  npx hardhat run scripts/demo/03-drop-price.ts             --network localhost    # drop 4 prices → liquidatable
npx hardhat run scripts/demo/dex-liquidation/04e-liquidate-multi-1inch.ts   --network localhost   # seizes WETH+WBTC+LINK on 1inch, leaves UNI
```
Each dropped price must stay ≤ its real fork price (else the swap reverts `InvalidMinAmountOut`); UNI stays high as
the untouched partial‑liquidation buffer.
