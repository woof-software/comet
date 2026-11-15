# Market-update deployment and verification helpers.
# Values may come from .env, the environment, or make NAME=value arguments.
-include .env

.DEFAULT_GOAL := help

SOLIDITY_COMPILER_VERSION ?= 0.8.15
EVM_VERSION ?= cancun
THRESHOLD ?= 2

# Export explicitly so Forge scripts also receive command-line Make variables.
export CHAIN_ID RPC_URL ETH_PK SALT SENDER OWNERS THRESHOLD
export ETHERSCAN_API_KEY SOLIDITY_COMPILER_VERSION EVM_VERSION
export MARKET_UPDATE_MULTISIG MARKET_ADMIN_TIMELOCK_ADDRESS MARKET_UPDATE_PROPOSER
export CONFIGURATOR_IMPL COMET_PROXY_ADMIN MARKET_ADMIN_PERMISSION_CHECKER

# Check before running external commands. Only variable names are printed.
require-vars = $(foreach name,$(1),$(if $(strip $(subst ",,$(subst ',,$($(name))))),,$(error $(name) is required for '$@'; set it in .env, the environment, or a make argument)))

.PHONY: help verify-all deploy-safe deploy-contracts compute-contracts-addresses \
        verify-MarketUpdateTimelock verify-MarketUpdateProposer verify-Configurator \
        verify-CometProxyAdmin verify-MarketAdminPermissionChecker

help:
	@printf '%s\n' \
	  'Targets: deploy-contracts, compute-contracts-addresses, deploy-safe, verify-all,' \
	  '         verify-MarketUpdateTimelock, verify-MarketUpdateProposer,' \
	  '         verify-Configurator, verify-CometProxyAdmin, verify-MarketAdminPermissionChecker' \
	  'Set network-specific values explicitly; no deployed addresses are assumed.' \
	  'Missing required values are reported before a command runs.' \
	  'deploy-safe currently has no script.'

verify-all:
	$(call require-vars,CHAIN_ID ETHERSCAN_API_KEY SENDER MARKET_UPDATE_MULTISIG MARKET_ADMIN_TIMELOCK_ADDRESS MARKET_UPDATE_PROPOSER CONFIGURATOR_IMPL COMET_PROXY_ADMIN MARKET_ADMIN_PERMISSION_CHECKER)
	@$(MAKE) verify-MarketUpdateTimelock verify-MarketUpdateProposer verify-Configurator verify-CometProxyAdmin verify-MarketAdminPermissionChecker

deploy-safe:
	$(if $(wildcard scripts/marketupdates/deploySafe.ts),,$(error deploy-safe is unavailable: scripts/marketupdates/deploySafe.ts is missing))
	$(call require-vars,OWNERS THRESHOLD SALT CHAIN_ID)
	@yarn hardhat run scripts/marketupdates/deploySafe.ts

deploy-contracts:
	$(call require-vars,CHAIN_ID RPC_URL SENDER ETH_PK SALT SOLIDITY_COMPILER_VERSION EVM_VERSION)
	@echo 'Deploying contracts...'
	@forge script forge/script/marketupdates/DeployContracts.s.sol:DeployContracts \
		--rpc-url "$$RPC_URL" \
		--optimize --optimizer-runs 1 \
		--use "$$SOLIDITY_COMPILER_VERSION" --evm-version "$$EVM_VERSION" \
		--broadcast --via-ir -vvv --sender "$$SENDER"

compute-contracts-addresses:
	$(call require-vars,CHAIN_ID RPC_URL SENDER ETH_PK SALT SOLIDITY_COMPILER_VERSION EVM_VERSION)
	@echo 'Computing contract addresses...'
	@forge script forge/script/marketupdates/ComputeContractsAddresses.s.sol:ComputeContractAddresses \
		--rpc-url "$$RPC_URL" \
		--optimize --optimizer-runs 1 \
		--use "$$SOLIDITY_COMPILER_VERSION" --evm-version "$$EVM_VERSION" \
		--via-ir -vvv --skip-simulation --sender "$$SENDER"

verify-MarketUpdateTimelock:
	$(call require-vars,CHAIN_ID ETHERSCAN_API_KEY SENDER MARKET_ADMIN_TIMELOCK_ADDRESS SOLIDITY_COMPILER_VERSION)
	@echo 'Verifying MarketUpdateTimelock...'
	@args=$$(cast abi-encode 'constructor(address,uint256)' "$$SENDER" 172800) && \
	forge verify-contract \
		--chain-id "$$CHAIN_ID" --compiler-version "$$SOLIDITY_COMPILER_VERSION" \
		--optimizer-runs 1 --constructor-args "$$args" \
		--etherscan-api-key "$$ETHERSCAN_API_KEY" --watch --via-ir \
		"$$MARKET_ADMIN_TIMELOCK_ADDRESS" \
		contracts/marketupdates/MarketUpdateTimelock.sol:MarketUpdateTimelock

verify-MarketUpdateProposer:
	$(call require-vars,CHAIN_ID ETHERSCAN_API_KEY SENDER MARKET_UPDATE_MULTISIG MARKET_ADMIN_TIMELOCK_ADDRESS MARKET_UPDATE_PROPOSER SOLIDITY_COMPILER_VERSION)
	@echo 'Verifying MarketUpdateProposer...'
	@args=$$(cast abi-encode 'constructor(address,address,address,address)' "$$SENDER" "$$MARKET_UPDATE_MULTISIG" 0x0000000000000000000000000000000000000000 "$$MARKET_ADMIN_TIMELOCK_ADDRESS") && \
	forge verify-contract \
		--chain-id "$$CHAIN_ID" --compiler-version "$$SOLIDITY_COMPILER_VERSION" \
		--optimizer-runs 1 --constructor-args "$$args" \
		--etherscan-api-key "$$ETHERSCAN_API_KEY" --watch --via-ir \
		"$$MARKET_UPDATE_PROPOSER" \
		contracts/marketupdates/MarketUpdateProposer.sol:MarketUpdateProposer

verify-CometProxyAdmin:
	$(call require-vars,CHAIN_ID ETHERSCAN_API_KEY SENDER COMET_PROXY_ADMIN SOLIDITY_COMPILER_VERSION)
	@echo 'Verifying CometProxyAdmin...'
	@args=$$(cast abi-encode 'constructor(address)' "$$SENDER") && \
	forge verify-contract \
		--chain-id "$$CHAIN_ID" --compiler-version "$$SOLIDITY_COMPILER_VERSION" \
		--optimizer-runs 1 --constructor-args "$$args" \
		--etherscan-api-key "$$ETHERSCAN_API_KEY" --watch --via-ir \
		"$$COMET_PROXY_ADMIN" contracts/CometProxyAdmin.sol:CometProxyAdmin

verify-Configurator:
	$(call require-vars,CHAIN_ID ETHERSCAN_API_KEY CONFIGURATOR_IMPL SOLIDITY_COMPILER_VERSION)
	@echo 'Verifying Configurator...'
	@forge verify-contract \
		--chain-id "$$CHAIN_ID" --compiler-version "$$SOLIDITY_COMPILER_VERSION" \
		--optimizer-runs 1 --etherscan-api-key "$$ETHERSCAN_API_KEY" --watch --via-ir \
		"$$CONFIGURATOR_IMPL" contracts/Configurator.sol:Configurator

verify-MarketAdminPermissionChecker:
	$(call require-vars,CHAIN_ID ETHERSCAN_API_KEY SENDER MARKET_UPDATE_MULTISIG MARKET_ADMIN_PERMISSION_CHECKER SOLIDITY_COMPILER_VERSION)
	@echo 'Verifying MarketAdminPermissionChecker...'
	@args=$$(cast abi-encode 'constructor(address,address,address)' "$$SENDER" "$$MARKET_UPDATE_MULTISIG" 0x0000000000000000000000000000000000000000) && \
	forge verify-contract \
		--chain-id "$$CHAIN_ID" --compiler-version "$$SOLIDITY_COMPILER_VERSION" \
		--optimizer-runs 1 --constructor-args "$$args" \
		--etherscan-api-key "$$ETHERSCAN_API_KEY" --watch --via-ir \
		"$$MARKET_ADMIN_PERMISSION_CHECKER" \
		contracts/marketupdates/MarketAdminPermissionChecker.sol:MarketAdminPermissionChecker
