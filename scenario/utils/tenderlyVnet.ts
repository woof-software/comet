import axios from 'axios';
import { DeploymentManager } from '../../plugins/deployment_manager';

export interface TenderlyVnetInfo {
  id: string;
  adminRpcUrl: string;
  publicRpcUrl: string;
  dashboardUrl?: string;
}

interface TenderlyCreds {
  account: string;
  project: string;
  accessKey: string;
}

function getTenderlyCreds(): TenderlyCreds {
  const account = process.env.TENDERLY_USERNAME || process.env.TENDERLY_ACCOUNT;
  const project = process.env.TENDERLY_PROJECT;
  const accessKey = process.env.TENDERLY_ACCESS_KEY;

  if (!account || !project || !accessKey) {
    throw new Error(
      'Missing Tenderly credentials to create a Virtual TestNet: set TENDERLY_USERNAME, TENDERLY_PROJECT ' +
      'and TENDERLY_ACCESS_KEY. Alternatively, set TENDERLY_VNET_RPC_URL to the Admin RPC URL of an ' +
      'already-created Virtual TestNet to reuse it instead of creating a new one.'
    );
  }
  return { account, project, accessKey };
}

/*
Admin RPC:  https://virtual.mainnet.eu.rpc.tenderly.co/<account>/<project>/<slug>-<adminSuffix>
Public RPC: https://virtual.mainnet.eu.rpc.tenderly.co/<account>/<project>/<slug>
*/
function publicRpcFromAdminRpc(adminRpcUrl: string): string {
  const url = new URL(adminRpcUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  const lastSegment = segments.pop() as string;

  segments.push(lastSegment.split('-')[0]);
  url.pathname = '/' + segments.join('/');
  return url.toString();
}

export async function createVirtualTestnet(
  dm: DeploymentManager,
  opts: { slug?: string, blockNumber?: number | 'latest' } = {}
): Promise<TenderlyVnetInfo> {
  const { account, project, accessKey } = getTenderlyCreds();
  const { chainId } = await dm.hre.ethers.provider.getNetwork();
  const slug = opts.slug ?? `comet-sim-${dm.network}-${Date.now()}`;

  const { data } = await axios.post(
    `https://api.tenderly.co/api/public/v1/account/${account}/project/${project}/environments`,
    {
      display_name: slug,
      slug,
      network_configs: [
        {
          network_id: String(chainId),
          block_number: opts.blockNumber ?? 'latest',
          explorer_config: {
            enabled: true,
            contract_verification_visibility: 'bytecode',
          },
        },
      ],
    },
    {
      headers: {
        'X-Access-Key': accessKey,
        'Content-Type': 'application/json',
      },
    }
  );

  const rpcs = data?.active_instance?.vnets?.[0]?.rpcs ?? [];
  const adminRpcUrl = rpcs.find((rpc: any) => rpc.name === 'Admin RPC')?.url;
  const publicRpcUrl = rpcs.find((rpc: any) => rpc.name === 'Public RPC')?.url;

  if (!adminRpcUrl) {
    throw new Error(`Tenderly did not return an Admin RPC URL for the new Virtual TestNet: ${JSON.stringify(data)}`);
  }

  const instanceId = data?.active_instance?.id;
  const dashboardUrl = instanceId
    ? `https://dashboard.tenderly.co/${account}/${project}/testnets/${data.id}/instance/${instanceId}`
    : undefined;

  console.log(`Created Tenderly Virtual TestNet '${slug}' for ${dm.network} (id: ${data.id})`);

  return {
    id: data.id,
    adminRpcUrl,
    publicRpcUrl: publicRpcUrl ?? publicRpcFromAdminRpc(adminRpcUrl),
    dashboardUrl,
  };
}

function envRpcUrlFor(network: string): string | undefined {
  return process.env[`TENDERLY_VNET_RPC_URL_${network.toUpperCase()}`] || process.env.TENDERLY_VNET_RPC_URL;
}

/*
Reuses a Virtual TestNet from TENDERLY_VNET_RPC_URL[_<NETWORK>] if set, otherwise creates a new one
via the Tenderly API. The env var is the escape hatch for accounts/tokens that can't create Virtual
TestNets programmatically (e.g. missing API scopes) - paste in an Admin RPC URL created via the
Tenderly dashboard instead.
*/
export async function getOrCreateVirtualTestnet(
  dm: DeploymentManager,
  opts: { slug?: string, blockNumber?: number | 'latest' } = {}
): Promise<TenderlyVnetInfo> {
  const envAdminRpcUrl = envRpcUrlFor(dm.network);

  if (envAdminRpcUrl) {
    console.log(`Reusing Tenderly Virtual TestNet Admin RPC from env for ${dm.network}`);
    return {
      id: 'from-env',
      adminRpcUrl: envAdminRpcUrl,
      publicRpcUrl: publicRpcFromAdminRpc(envAdminRpcUrl),
    };
  }

  return createVirtualTestnet(dm, opts);
}
