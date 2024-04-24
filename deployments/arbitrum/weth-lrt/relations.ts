import baseRelationConfig from '../../relations';

export default {
  ...baseRelationConfig,
  'governor': {
    artifact: 'contracts/bridges/polygon/PolygonBridgeReceiver.sol:PolygonBridgeReceiver',
  },
  TransparentUpgradeableProxy: {
    artifact: 'contracts/ERC20.sol:ERC20'
  },
  ClonableBeaconProxy: {
    artifact: 'contracts/ERC20.sol:ERC20'
  },
  // WETH
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': {
    artifact: 'contracts/ERC20.sol:ERC20',
    delegates: {
      field: {
        slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
      }
    }
  },
  // ezETH
  '0x2416092f143378750bb29b79eD961ab195CcEea5': {
    artifact: 'contracts/ERC20.sol:ERC20',
    delegates: {
      field: {
        slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
      }
    }
  }
};