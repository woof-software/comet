TODO - Review

# Rewards V2. Proof generation script

The idea of Rewards V2 is discribed in datials [here](Link to readme file in this repository)

## The logic of the script is

1. Collect all the users from the comet creation block to defined block
2. Get accrued values for the users on the block of proof file generation
mutlicall to simulate accrue call
3. Generate input data for sorted Merkle tree
4. Generate sorted Merkle tree
5. Generate and save file

[Verify merkel tree](link to new created verificaiton logic) can be used by the workflow to verify if saved Merkle tree is properly generated.

Extra step to verify generated info is Dune dashboard, that can display all the users that interacted with the protocol
