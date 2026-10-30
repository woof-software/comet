import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import fs from 'fs';
import * as path from 'path';
import { DeploymentManager } from '../DeploymentManager';

describe('DeploymentManager relay and bytecode files', () => {
  const cacheDir = path.resolve(__dirname, '../../..', 'cache');
  const relayFile = path.join(cacheDir, 'relay.json');
  const bytecodeFile = path.join(cacheDir, 'bytecodes.json');
  const original = {
    existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
    warn: console.warn,
  };
  const relay = { messenger: '0x1111111111111111111111111111111111111111', callData: '0x1234', signer: '0x2222222222222222222222222222222222222222' };
  let files: Map<string, string>;
  let writes: Array<{ file: string, content: string }>;
  let warnings: unknown[][];
  let manager: DeploymentManager;
  let failDirectory: boolean;
  let failWrite: boolean;
  const failure = new Error('Injected auxiliary filesystem failure');

  beforeEach(() => {
    files = new Map();
    writes = [];
    warnings = [];
    failDirectory = false;
    failWrite = false;
    manager = new DeploymentManager('test-network', 'test-deployment', hre);
    // Intercept only the fixed auxiliary paths; never read or write real cache files.
    Object.assign(fs, {
      existsSync: (file: Parameters<typeof fs.existsSync>[0]) => files.has(String(file)) || (String(file) !== relayFile && String(file) !== bytecodeFile && original.existsSync(file)),
      mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
        const [dir] = args;
        if (String(dir) !== cacheDir) return original.mkdirSync(...args);
        if (failDirectory) throw failure;
        return undefined;
      },
      readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
        const [file] = args;
        if (String(file) === relayFile || String(file) === bytecodeFile) return files.get(String(file));
        return original.readFileSync(...args);
      },
      writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
        const [file, content] = args;
        if (String(file) !== relayFile && String(file) !== bytecodeFile) return original.writeFileSync(...args);
        if (failWrite) throw failure;
        const text = String(content);
        files.set(String(file), text);
        writes.push({ file: String(file), content: text });
      },
    });
    console.warn = (...args: unknown[]) => { warnings.push(args); };
  });
  afterEach(() => {
    Object.assign(fs, {
      existsSync: original.existsSync, mkdirSync: original.mkdirSync,
      readFileSync: original.readFileSync, writeFileSync: original.writeFileSync,
    });
    console.warn = original.warn;
  });

  it('creates and appends relay entries while skipping an identical entry without rewriting', () => {
    manager.stashRelayMessage(relay.messenger, relay.callData, relay.signer);
    expect(JSON.parse(files.get(relayFile)!)).to.eql([relay]);
    manager.stashRelayMessage(relay.messenger, '0xabcd', relay.signer);
    const expected = [relay, { ...relay, callData: '0xabcd' }];
    expect(JSON.parse(files.get(relayFile)!)).to.eql(expected);
    manager.stashRelayMessage(relay.messenger, relay.callData, relay.signer);
    expect(JSON.parse(files.get(relayFile)!)).to.eql(expected);
    expect(writes).to.have.length(2);
    expect(warnings).to.eql([]);
  });

  it('creates and appends bytecodes, including duplicate entries', () => {
    manager.stashBytecode('0x1234');
    expect(JSON.parse(files.get(bytecodeFile)!)).to.eql(['0x1234']);
    manager.stashBytecode('0xabcd');
    manager.stashBytecode('0x1234');
    expect(JSON.parse(files.get(bytecodeFile)!)).to.eql(['0x1234', '0xabcd', '0x1234']);
    expect(writes).to.have.length(3);
    expect(warnings).to.eql([]);
  });

  for (const kind of ['relay', 'bytecode'] as const) {
    const file = kind === 'relay' ? relayFile : bytecodeFile;
    const next = kind === 'relay' ? relay : '0xabcd';
    const previous = kind === 'relay' ? { ...relay, callData: '0x5678' } : '0x1234';
    const stash = (dm: DeploymentManager) => kind === 'relay'
      ? dm.stashRelayMessage(relay.messenger, relay.callData, relay.signer) : dm.stashBytecode('0xabcd');

    for (const state of ['empty', 'malformed', 'legacy single entry'] as const) {
      it(`handles ${state} content in the ${kind} file`, () => {
        files.set(file, state === 'empty' ? '  \n' : state === 'malformed' ? '{unfinished' : JSON.stringify(previous));
        stash(manager);
        expect(JSON.parse(files.get(file)!)).to.eql(state === 'legacy single entry' ? [previous, next] : [next]);
        expect(writes).to.have.length(1);
        expect(warnings).to.have.length(state === 'malformed' ? 1 : 0);
        if (state === 'malformed') expect(warnings[0][0]).to.equal('Invalid cache, recreating:');
      });
    }

    for (const boundary of ['directory creation', 'file write'] as const) {
      it(`warns without throwing or recording a successful ${kind} write when ${boundary} fails`, () => {
        const saved = JSON.stringify([previous]);
        files.set(file, saved);
        failDirectory = boundary === 'directory creation';
        failWrite = boundary === 'file write';
        assert.doesNotThrow(() => stash(manager));
        expect(writes).to.eql([]);
        expect(files.get(file)).to.equal(saved);
        expect(warnings).to.have.length(1);
        expect(warnings[0]).to.eql(['Failed to cache proposal:', failure]);
        // This stub fails before writing; it does not claim rollback after a partial disk write.
        failDirectory = false;
        failWrite = false;
        stash(manager);
        expect(JSON.parse(files.get(file)!)).to.eql([previous, next]);
        expect(writes).to.have.length(1);
      });
    }
  }
});
