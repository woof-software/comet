#!/usr/bin/env ts-node

import { ethers } from 'ethers';
import { Configurator__factory } from '../build/types';
import { CometExt__factory } from '../build/types';

// Configuration for different networks
const NETWORK_CONFIG = {
  mainnet: {
    rpcUrl: 'https://mainnet.infura.io/v3/YOUR_INFURA_KEY',
    configuratorAddress: '0x316f9708bB98af7dA9c68C1C3b564e2c15651Ccd', // Example address
  },
  base: {
    rpcUrl: 'https://mainnet.base.org',
    configuratorAddress: '0x316f9708bB98af7dA9c68C1C3b564e2c15651Ccd', // Example address
  },
  localhost: {
    rpcUrl: 'http://localhost:8545',
    configuratorAddress: '0x316f9708bB98af7dA9c68C1C3b564e2c15651Ccd', // Example address
  }
};

// Comet proxy addresses for different networks
const COMET_ADDRESSES = {
  mainnet: {
    usdc: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    weth: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
  },
  base: {
    usdbc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth: '0x4200000000000000000000000000000000000006',
  },
  localhost: {
    dai: '0x1234567890123456789012345678901234567890', // Example address
  }
};

interface ConfigurationResult {
  governor: string;
  pauseGuardian: string;
  baseToken: string;
  baseTokenPriceFeed: string;
  extensionDelegate: string;
  supplyKink: string;
  supplyPerYearInterestRateSlopeLow: string;
  supplyPerYearInterestRateSlopeHigh: string;
  supplyPerYearInterestRateBase: string;
  borrowKink: string;
  borrowPerYearInterestRateSlopeLow: string;
  borrowPerYearInterestRateSlopeHigh: string;
  borrowPerYearInterestRateBase: string;
  storeFrontPriceFactor: string;
  trackingIndexScale: string;
  baseTrackingSupplySpeed: string;
  baseTrackingBorrowSpeed: string;
  baseMinForRewards: string;
  baseBorrowMin: string;
  targetReserves: string;
  assetConfigs: Array<{
    asset: string;
    priceFeed: string;
    decimals: number;
    borrowCollateralFactor: string;
    liquidateCollateralFactor: string;
    liquidationFactor: string;
    supplyCap: string;
  }>;
}

class CometConfigurationReader {
  private provider: ethers.providers.JsonRpcProvider;
  private configurator: ethers.Contract;
  private network: string;

  constructor(network: string = 'localhost', rpcUrl?: string) {
    this.network = network;
    const config = NETWORK_CONFIG[network as keyof typeof NETWORK_CONFIG];
    
    if (!config) {
      throw new Error(`Unsupported network: ${network}`);
    }

    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl || config.rpcUrl);
    this.configurator = Configurator__factory.connect(config.configuratorAddress, this.provider);
  }

  /**
   * Get configuration from Configurator contract
   * @param cometProxyAddress - Address of the Comet proxy
   * @returns Configuration object
   */
  async getConfigurationFromConfigurator(cometProxyAddress: string): Promise<ConfigurationResult> {
    try {
      console.log(`Getting configuration for Comet proxy: ${cometProxyAddress}`);
      
      const config = await this.configurator.getConfiguration(cometProxyAddress);
      
      // Convert BigNumber values to strings for better readability
      const result: ConfigurationResult = {
        governor: config.governor,
        pauseGuardian: config.pauseGuardian,
        baseToken: config.baseToken,
        baseTokenPriceFeed: config.baseTokenPriceFeed,
        extensionDelegate: config.extensionDelegate,
        supplyKink: config.supplyKink.toString(),
        supplyPerYearInterestRateSlopeLow: config.supplyPerYearInterestRateSlopeLow.toString(),
        supplyPerYearInterestRateSlopeHigh: config.supplyPerYearInterestRateSlopeHigh.toString(),
        supplyPerYearInterestRateBase: config.supplyPerYearInterestRateBase.toString(),
        borrowKink: config.borrowKink.toString(),
        borrowPerYearInterestRateSlopeLow: config.borrowPerYearInterestRateSlopeLow.toString(),
        borrowPerYearInterestRateSlopeHigh: config.borrowPerYearInterestRateSlopeHigh.toString(),
        borrowPerYearInterestRateBase: config.borrowPerYearInterestRateBase.toString(),
        storeFrontPriceFactor: config.storeFrontPriceFactor.toString(),
        trackingIndexScale: config.trackingIndexScale.toString(),
        baseTrackingSupplySpeed: config.baseTrackingSupplySpeed.toString(),
        baseTrackingBorrowSpeed: config.baseTrackingBorrowSpeed.toString(),
        baseMinForRewards: config.baseMinForRewards.toString(),
        baseBorrowMin: config.baseBorrowMin.toString(),
        targetReserves: config.targetReserves.toString(),
        assetConfigs: config.assetConfigs.map(asset => ({
          asset: asset.asset,
          priceFeed: asset.priceFeed,
          decimals: asset.decimals,
          borrowCollateralFactor: asset.borrowCollateralFactor.toString(),
          liquidateCollateralFactor: asset.liquidateCollateralFactor.toString(),
          liquidationFactor: asset.liquidationFactor.toString(),
          supplyCap: asset.supplyCap.toString(),
        })),
      };

      return result;
    } catch (error) {
      console.error('Error getting configuration from Configurator:', error);
      throw error;
    }
  }

  /**
   * Get configuration from Comet extension delegate
   * Note: CometExt doesn't have a getConfiguration method, but we can get some basic info
   * @param cometExtAddress - Address of the Comet extension delegate
   * @returns Basic extension information
   */
  async getCometExtInfo(cometExtAddress: string): Promise<any> {
    try {
      console.log(`Getting CometExt info for: ${cometExtAddress}`);
      
      const cometExt = CometExt__factory.connect(cometExtAddress, this.provider);
      
      const [name, symbol, version, baseAccrualScale, baseIndexScale, factorScale, priceScale, maxAssets] = await Promise.all([
        cometExt.name(),
        cometExt.symbol(),
        cometExt.version(),
        cometExt.baseAccrualScale(),
        cometExt.baseIndexScale(),
        cometExt.factorScale(),
        cometExt.priceScale(),
        cometExt.maxAssets(),
      ]);

      return {
        name,
        symbol,
        version,
        baseAccrualScale: baseAccrualScale.toString(),
        baseIndexScale: baseIndexScale.toString(),
        factorScale: factorScale.toString(),
        priceScale: priceScale.toString(),
        maxAssets: maxAssets.toString(),
      };
    } catch (error) {
      console.error('Error getting CometExt info:', error);
      throw error;
    }
  }

  /**
   * Get configuration for a specific Comet instance
   * @param cometSymbol - Symbol of the Comet instance (e.g., 'usdc', 'weth')
   * @returns Configuration object
   */
  async getCometConfiguration(cometSymbol: string): Promise<ConfigurationResult> {
    const cometAddresses = COMET_ADDRESSES[this.network as keyof typeof COMET_ADDRESSES];
    
    if (!cometAddresses) {
      throw new Error(`No Comet addresses configured for network: ${this.network}`);
    }

    const cometAddress = cometAddresses[cometSymbol as keyof typeof cometAddresses];
    
    if (!cometAddress) {
      throw new Error(`No Comet address found for symbol: ${cometSymbol} on network: ${this.network}`);
    }

    return this.getConfigurationFromConfigurator(cometAddress);
  }

  /**
   * Print configuration in a readable format
   * @param config - Configuration object to print
   */
  printConfiguration(config: ConfigurationResult): void {
    console.log('\n=== Comet Configuration ===');
    console.log(`Governor: ${config.governor}`);
    console.log(`Pause Guardian: ${config.pauseGuardian}`);
    console.log(`Base Token: ${config.baseToken}`);
    console.log(`Base Token Price Feed: ${config.baseTokenPriceFeed}`);
    console.log(`Extension Delegate: ${config.extensionDelegate}`);
    console.log('\n=== Interest Rate Parameters ===');
    console.log(`Supply Kink: ${config.supplyKink}`);
    console.log(`Supply Per Year Interest Rate Slope Low: ${config.supplyPerYearInterestRateSlopeLow}`);
    console.log(`Supply Per Year Interest Rate Slope High: ${config.supplyPerYearInterestRateSlopeHigh}`);
    console.log(`Supply Per Year Interest Rate Base: ${config.supplyPerYearInterestRateBase}`);
    console.log(`Borrow Kink: ${config.borrowKink}`);
    console.log(`Borrow Per Year Interest Rate Slope Low: ${config.borrowPerYearInterestRateSlopeLow}`);
    console.log(`Borrow Per Year Interest Rate Slope High: ${config.borrowPerYearInterestRateSlopeHigh}`);
    console.log(`Borrow Per Year Interest Rate Base: ${config.borrowPerYearInterestRateBase}`);
    console.log('\n=== Other Parameters ===');
    console.log(`Store Front Price Factor: ${config.storeFrontPriceFactor}`);
    console.log(`Tracking Index Scale: ${config.trackingIndexScale}`);
    console.log(`Base Tracking Supply Speed: ${config.baseTrackingSupplySpeed}`);
    console.log(`Base Tracking Borrow Speed: ${config.baseTrackingBorrowSpeed}`);
    console.log(`Base Min For Rewards: ${config.baseMinForRewards}`);
    console.log(`Base Borrow Min: ${config.baseBorrowMin}`);
    console.log(`Target Reserves: ${config.targetReserves}`);
    console.log('\n=== Asset Configurations ===');
    config.assetConfigs.forEach((asset, index) => {
      console.log(`Asset ${index + 1}:`);
      console.log(`  Address: ${asset.asset}`);
      console.log(`  Price Feed: ${asset.priceFeed}`);
      console.log(`  Decimals: ${asset.decimals}`);
      console.log(`  Borrow Collateral Factor: ${asset.borrowCollateralFactor}`);
      console.log(`  Liquidate Collateral Factor: ${asset.liquidateCollateralFactor}`);
      console.log(`  Liquidation Factor: ${asset.liquidationFactor}`);
      console.log(`  Supply Cap: ${asset.supplyCap}`);
    });
  }
}

// Main execution function
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: ts-node get-configuration.ts <network> [comet-symbol] [rpc-url]');
    console.log('Examples:');
    console.log('  ts-node get-configuration.ts localhost dai');
    console.log('  ts-node get-configuration.ts mainnet usdc');
    console.log('  ts-node get-configuration.ts base usdbc');
    console.log('  ts-node get-configuration.ts localhost dai http://localhost:8545');
    process.exit(1);
  }

  const network = args[0];
  const cometSymbol = args[1] || 'dai';
  const rpcUrl = args[2];

  try {
    const reader = new CometConfigurationReader(network, rpcUrl);
    
    console.log(`\nReading configuration for ${cometSymbol} on ${network}...`);
    
    // Get configuration from Configurator
    const config = await reader.getCometConfiguration(cometSymbol);
    reader.printConfiguration(config);
    
    // Also get CometExt info if extension delegate is available
    if (config.extensionDelegate && config.extensionDelegate !== '0x0000000000000000000000000000000000000000') {
      console.log('\n=== Comet Extension Info ===');
      const extInfo = await reader.getCometExtInfo(config.extensionDelegate);
      console.log(`Name: ${extInfo.name}`);
      console.log(`Symbol: ${extInfo.symbol}`);
      console.log(`Version: ${extInfo.version}`);
      console.log(`Base Accrual Scale: ${extInfo.baseAccrualScale}`);
      console.log(`Base Index Scale: ${extInfo.baseIndexScale}`);
      console.log(`Factor Scale: ${extInfo.factorScale}`);
      console.log(`Price Scale: ${extInfo.priceScale}`);
      console.log(`Max Assets: ${extInfo.maxAssets}`);
    }
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the script if called directly
if (require.main === module) {
  main().catch(console.error);
}

export { CometConfigurationReader, ConfigurationResult };





















