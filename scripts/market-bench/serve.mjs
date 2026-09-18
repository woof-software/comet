#!/usr/bin/env node
// Server for the bench: static files, plus a small API that reads live markets
// and keeps their snapshots in the repository.
//
// The page loads ES modules and fetches JSON — both blocked on file:// — so it
// needs an http origin. Snapshots go to data/market-presets.json, which means
// they survive a restart, travel with a clone and show up in a diff.
//
//   node scripts/market-bench/serve.mjs [--port 8777] [--open]
//
// The write surface is deliberately narrow: loopback only, one file, one shape.
//   GET    /api/markets                 → every market the SDK knows, per chain
//   GET    /api/market-presets          → { presets: [...] }
//   POST   /api/market-presets          → { chainId, market } → read chain, store
//   POST   /api/market-presets/:id      → re-read that market, replace in place
//   DELETE /api/market-presets/:id      → 204

import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MARKET_FILE = join(ROOT, 'data', 'market-presets.json');   // pulled from chain, refreshable

const MAX_BODY = 64 * 1024;

const flag = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
};
const port = Number(flag('--port', 8777));

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.md':   'text/plain; charset=utf-8',
};

/* ============================ snapshot file ============================ */

async function readJson(file) {
    try {
        const rows = JSON.parse(await readFile(file, 'utf8'));
        return Array.isArray(rows) ? rows : [];
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

async function writeJson(file, rows) {
    // temp + rename: an interrupted write can never leave a truncated file behind
    const tmp = file + '.tmp';
    await writeFile(tmp, JSON.stringify(rows, null, 2) + '\n');
    await rename(tmp, file);
}

const json = (res, code, body) =>
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
       .end(JSON.stringify(body));

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);   // ['api', <what>, id?, action?]
    if (parts[1] === 'markets') return handleMarketCatalog(req, res, parts);
    if (parts[1] === 'market-presets') return handleMarketPresets(req, res, parts);
    return json(res, 404, { error: 'no such endpoint' });
}

/* ---- markets read from chain, refreshable from the page ---- */

// The SDK is loaded on first use, not at startup: a broken install must not take
// the static bench down with it.
const sdkError = (e) => ({ error: `chain read failed: ${e.message}` });

async function handleMarketCatalog(req, res, parts) {
    if (parts.length !== 2) return json(res, 404, { error: 'no such endpoint' });
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    try {
        const { listMarkets } = await import('./server/market.mjs');
        return json(res, 200, { chains: await listMarkets() });
    } catch (e) {
        console.error(e);
        return json(res, 502, sdkError(e));
    }
}

async function handleMarketPresets(req, res, parts) {
    const id = parts[2];
    const action = parts[3];
    if (parts.length > 4 || (action && action !== 'refresh')) return json(res, 404, { error: 'no such endpoint' });

    if (req.method === 'GET' && !id) {
        return json(res, 200, { presets: await readJson(MARKET_FILE) });
    }

    // add a market, or re-read one already on the list — same fetch either way
    if (req.method === 'POST') {
        const rows = await readJson(MARKET_FILE);
        let chainId, market;

        if (id) {
            const existing = rows.find(p => p.id === id);
            if (!existing) return json(res, 404, { error: 'no such preset' });
            ({ chainId, market } = existing);
        } else {
            let body;
            try { body = JSON.parse(await readBody(req)); }
            catch { return json(res, 400, { error: 'body must be JSON under 64 KB' }); }
            chainId = Number(body?.chainId);
            market = body?.market;
            if (!Number.isInteger(chainId)) return json(res, 400, { error: 'chainId must be an integer' });
            if (typeof market !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(market))
                return json(res, 400, { error: 'market must be a 0x address' });
        }

        let preset;
        try {
            const { fetchMarketPreset } = await import('./server/market.mjs');
            preset = await fetchMarketPreset(chainId, market);
        } catch (e) {
            console.error(e);
            return json(res, 502, sdkError(e));
        }

        // one row per market: a refresh replaces in place and keeps the order
        const at = rows.findIndex(p => p.id === preset.id);
        if (at === -1) rows.push(preset); else rows[at] = preset;
        await writeJson(MARKET_FILE, rows);
        console.log(`${at === -1 ? '+' : '~'} market ${preset.name} @ block ${preset.source.block} → data/market-presets.json`);
        return json(res, at === -1 ? 201 : 200, { preset });
    }

    if (req.method === 'DELETE' && id) {
        const rows = await readJson(MARKET_FILE);
        const kept = rows.filter(p => p.id !== id);
        if (kept.length === rows.length) return json(res, 404, { error: 'no such preset' });
        await writeJson(MARKET_FILE, kept);
        console.log(`- market ${id} removed from data/market-presets.json`);
        return res.writeHead(204).end();
    }

    return json(res, 405, { error: 'method not allowed' });
}

/* ============================ server ============================ */

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

        const rel = decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname);
        const file = join(ROOT, normalize(rel));

        // nothing outside the bench directory is servable
        if (!file.startsWith(ROOT + sep)) return res.writeHead(403).end('forbidden');

        const body = await readFile(file);
        res.writeHead(200, {
            'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
            // a bench is edited while it is open; never hand back a stale module
            'cache-control': 'no-store',
        }).end(body);
    } catch (e) {
        if (e.code === 'ENOENT') return res.writeHead(404).end('not found');
        console.error(e);
        if (!res.headersSent) res.writeHead(500).end('server error');
    }
});

server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Comet Market Bench → ${url}   (Ctrl-C to stop)`);
    console.log('market snapshots → data/market-presets.json');
    if (process.argv.includes('--open')) {
        const opener = { darwin: 'open', win32: 'start', linux: 'xdg-open' }[process.platform];
        if (opener) spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    }
});
