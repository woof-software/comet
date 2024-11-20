import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeploymentManager } from "../../plugins/deployment_manager";

export type CampaignType = 'start' | 'finish'

export type IncentivizationCampaignData = {
    root: string;
    network: string;
    market: string;
    type: CampaignType;
    blockNumber: number;
    generatedTimestamp: number;
    startBlock?: number;
    data: {
        [address: string]: {
            accrue: string;
            proof: { proof: string[], v: string[] };
            index: number;
        };
    };
}

export type SaveFilePayload = {
    generatedTimestamp: number;
    blockNumber: number;
    type: CampaignType;
    network: string;
    deployment: string;
    fileData: IncentivizationCampaignData;
}

export type CollectDataPayload = {
    blockNumber: number;
    network: string;
    deployment: string;
    dm: DeploymentManager;
    generatedTimestamp: number;
    type: CampaignType;
    hre: HardhatRuntimeEnvironment
}