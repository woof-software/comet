// JSON-RPC plumbing for the market fetcher.
//
// The SDK takes an `rpc` object rather than a URL, so this builds one: a plain
// fetch to the first endpoint that answers. Endpoints come from the repo .env —
// the same QuickNode keys scripts/comet-market-snapshot.mjs uses — with public
// nodes standing in when a key is missing or the node is down.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = process.env.COMET_ENV_PATH
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');

function loadEnv(path) {
    const out = {};
    try {
        for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq < 0) continue;
            // keys here sometimes carry a trailing space before '=', and values are quoted
            out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        }
    } catch { /* no .env: public endpoints alone */ }
    return out;
}

const env = loadEnv(ENV_PATH);

// chainId → endpoints, best first. Chain ids are the SDK's Chain enum.
// Two public fallbacks behind every .env key, because one is not a fallback: the
// mainnet QuickNode link in this repo currently fails its TLS handshake, and
// eth.llamarpc.com answers with an HTML block page rather than JSON.
export const ENDPOINTS = {
    1:        [env.MAINNET_QUICKNODE_LINK, 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://eth.merkle.io'],
    10:       [env.OPTIMISM_QUICKNODE_LINK, 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],
    130:      [env.UNICHAIN_QUICKNODE_LINK, 'https://unichain-rpc.publicnode.com', 'https://unichain.drpc.org'],
    137:      [env.POLYGON_QUICKNODE_LINK, 'https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
    2020:     [env.RONIN_QUICKNODE_LINK, 'https://api.roninchain.com/rpc', 'https://ronin.drpc.org'],
    5000:     [env.MANTLE_QUICKNODE_LINK, 'https://mantle-rpc.publicnode.com', 'https://mantle.drpc.org'],
    8453:     [env.BASE_QUICKNODE_LINK, 'https://base-rpc.publicnode.com', 'https://base.drpc.org'],
    42161:    [env.ARBITRUM_QUICKNODE_LINK, 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
    59144:    [env.LINEA_QUICKNODE_LINK, 'https://linea-rpc.publicnode.com', 'https://linea.drpc.org'],
    534352:   [env.SCROLL_RPC_URL, 'https://scroll-rpc.publicnode.com', 'https://scroll.drpc.org'],
    11155111: ['https://ethereum-sepolia-rpc.publicnode.com'],
};

export const CHAIN_NAMES = {
    1: 'ethereum', 10: 'optimism', 130: 'unichain', 137: 'polygon', 2020: 'ronin',
    5000: 'mantle', 8453: 'base', 42161: 'arbitrum', 59144: 'linea', 534352: 'scroll',
    11155111: 'sepolia',
};

const REQUEST_TIMEOUT = 15_000;

// An endpoint that cannot answer (dead, blocked, rate-limited, serving HTML) is
// worth retrying elsewhere. A chain that answers with a JSON-RPC error has
// answered — retrying the next node only hides what it said.
class TransportError extends Error {}
class RpcError extends Error {}

// A QuickNode host puts a unique endpoint name in the leftmost label and the
// token in the path. Report provider and network, never either of those.
export function endpointLabel(url) {
    try {
        const labels = new URL(url).host.split('.');
        return labels.slice(Math.max(0, labels.length - 3)).join('.');
    } catch { return 'endpoint'; }
}

function transportReason(e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return `timeout ${REQUEST_TIMEOUT / 1000}s`;
    return e.cause?.code ?? e.cause?.message ?? e.message;
}

const looksThrottled = (error) =>
    error.code === -32005 || /rate.?limit|too many requests|capacity|quota/i.test(error.message ?? '');

async function callOne(url, method, params) {
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
    } catch (e) {
        throw new TransportError(transportReason(e));
    }
    if (!res.ok) throw new TransportError(`HTTP ${res.status}`);

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); }
    catch { throw new TransportError(`answered with non-JSON (${res.headers.get('content-type') ?? 'no type'})`); }

    if (body.error) {
        if (looksThrottled(body.error)) throw new TransportError(`rate limit: ${body.error.message}`);
        throw new RpcError(`${method}: ${body.error.message}`);
    }
    return body.result;
}

// One transport per chain, remembering which endpoint last worked.
export function makeTransport(chainId) {
    const urls = (ENDPOINTS[chainId] ?? []).filter(Boolean);
    if (urls.length === 0) throw new Error(`no RPC endpoint configured for chain ${chainId}`);
    let preferred = 0;

    const send = async (method, params) => {
        const failures = [];
        for (let i = 0; i < urls.length; i++) {
            const at = (preferred + i) % urls.length;
            try {
                const result = await callOne(urls[at], method, params);
                preferred = at;                       // stick to whatever answered
                return result;
            } catch (e) {
                if (e instanceof RpcError) throw e;   // the chain answered; do not paper over it
                failures.push(`${endpointLabel(urls[at])}: ${e.message}`);
            }
        }
        // Naming every endpoint and its reason is the whole point: "fetch failed"
        // says nothing about which node died or why.
        throw new Error(`no RPC for chain ${chainId} answered — ${failures.join('; ')}`);
    };

    // A preset records which endpoint answered, and presets are committed.
    send.host = () => endpointLabel(urls[preferred]);
    return send;
}

export const blockParam = (block) =>
    typeof block === 'bigint' ? '0x' + block.toString(16) : (block ?? 'latest');
