// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import { Test } from "forge-std/Test.sol";

/**
 * @dev The live Configurator and Comet proxies of every chain the fork migration test runs on, taken from the
 *      roots.json files in deployments/. Mainnet's institutional_usdc market is left out, it has its own Configurator
 */
contract ConfiguratorMigrationForkBase is Test {
    uint256 internal constant MAINNET = 1;
    uint256 internal constant OPTIMISM = 10;
    uint256 internal constant BASE = 8453;
    uint256 internal constant ARBITRUM = 42161;

    mapping(uint256 => address) internal configurators;
    mapping(uint256 => address[]) internal comets;

    constructor() {
        configurators[MAINNET] = 0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3;
        comets[MAINNET].push(0xc3d688B66703497DAA19211EEdff47f25384cdc3); // usdc
        comets[MAINNET].push(0x5D409e56D886231aDAf00c8775665AD0f9897b56); // usds
        comets[MAINNET].push(0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840); // usdt
        comets[MAINNET].push(0xe85Dc543813B8c2CFEaAc371517b925a166a9293); // wbtc
        comets[MAINNET].push(0xA17581A9E3356d9A858b789D68B4d866e593aE94); // weth
        comets[MAINNET].push(0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3); // wsteth

        configurators[ARBITRUM] = 0xb21b06D71c75973babdE35b49fFDAc3F82Ad3775;
        comets[ARBITRUM].push(0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA); // usdc.e
        comets[ARBITRUM].push(0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf); // usdc
        comets[ARBITRUM].push(0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07); // usdt
        comets[ARBITRUM].push(0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486); // weth

        configurators[BASE] = 0x45939657d1CA34A8FA39A924B71D28Fe8431e581;
        comets[BASE].push(0x784efeB622244d2348d4F2522f8860B96fbEcE89); // aero
        comets[BASE].push(0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf); // usdbc
        comets[BASE].push(0xb125E6687d4313864e53df431d5425969c15Eb2F); // usdc
        comets[BASE].push(0x2c776041CCFe903071AF44aa147368a9c8EEA518); // usds
        comets[BASE].push(0x46e6b214b524310239732D51387075E0e70970bf); // weth

        configurators[OPTIMISM] = 0x84E93EC6170ED630f5ebD89A1AAE72d4F63f2713;
        comets[OPTIMISM].push(0x2e44e174f7D53F0212823acC11C01A11d58c5bCB); // usdc
        comets[OPTIMISM].push(0x995E394b8B2437aC8Ce61Ee0bC610D617962B214); // usdt
        comets[OPTIMISM].push(0xE36A30D249f7761327fd973001A32010b521b6Fd); // weth
    }

    /// @dev Creates and selects a fork from an rpc alias in foundry.toml, then returns that chain's Configurator and Comets
    function createFork(string memory rpc) internal returns (address configurator, address[] memory cometList) {
        vm.createSelectFork(rpc);
        configurator = configurators[block.chainid];
        cometList = comets[block.chainid];
        require(configurator != address(0), "no markets for this chain");
    }
}
