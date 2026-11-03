#!/bin/sh
# solidity-coverage finds sources with a `contracts/**/*.sol` glob. The capo submodule commits
# its ABI exports in folders named after the source file (abi/json/.../IERC20.sol/IERC20.json),
# so the glob picks those folders up and the run crashes reading them as Solidity files.
# Move capo's abi/ out of the tree for the run and always put it back afterwards.
ABI=contracts/capo/abi
if [ -d "$ABI" ]; then
  TMP=$(mktemp -d)
  mv "$ABI" "$TMP/abi"
  trap 'mv "$TMP/abi" "$ABI"; rmdir "$TMP"' EXIT
  trap 'exit 130' INT TERM
fi

NODE_OPTIONS='--max-old-space-size=8192' hardhat coverage "$@"
