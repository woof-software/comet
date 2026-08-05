// TODO: Could define strict types for these objects
export interface Requirements {
    filter?: (context) => Promise<boolean>; // Filter constraint
    upgrade?: boolean | object; // Modern constraint
    pause?: object; // Pause constraint
    supplyCaps?: object; // Supply cap constraint
    cometBalances?: object; // Comet balance constraint
    tokenBalances?: object; // Token balance constraint
    utilization?: number; // Utilization constraint
    prices?: object; // Price constraint
    reserves?: number | string; // Reserves constraint
    proposal?: true | { // Governance proposal constraint
        state?: 'pending' | 'active' | 'succeeded' | 'queued'; // default 'pending'
        proposer?: number; // index into context.getProposer(), default 0
        actions?: (context) => Promise<{ targets: string[], values: number[], calldatas: string[], description: string }>;
    };
    timelockPendingAdmin?: string; // Timelock pending admin constraint: actor name or literal address
}