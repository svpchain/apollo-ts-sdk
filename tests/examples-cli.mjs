import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createAgentSigner,
  decodeAction,
  decodeAuth,
  transactionHash,
  verifyAgentSignature,
} from '../dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const seed = new Uint8Array(32).fill(7);
const publicKey = createAgentSigner(seed, 1, 0).publicKey;
const genesis = `0x${'03'.repeat(32)}`;
const originalOrderId = '9007199254740993';

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`.examples-dist/${file}.js`, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('example CLIs query, prepare without broadcast and submit only the selected order', async () => {
  let open = true;
  const submitted = [];
  const calls = [];
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const q = JSON.parse(body);
      const method = q.method.split('.').at(-1);
      calls.push({ method, params: q.params });
      let result;
      switch (method) {
        case 'GetChainInfo':
          result = { chainId: 'example-fixture', genesisHash: genesis, executedHeight: '100' };
          break;
        case 'ListMarkets':
          result = {
            markets: [
              {
                id: 0,
                ticker: 'BTC-USD',
                status: 'MARKET_STATUS_ACTIVE',
                priceExponent: -5,
                atomicResolution: -10,
                quantumConversionExponent: -9,
                stepBaseQuantums: '1000000',
                subticksPerTick: '100000',
                mark: '6500000000',
              },
            ],
          };
          break;
        case 'GetOpenOrders':
          assert.equal(q.params.account, '7');
          assert.equal(q.params.market, 0);
          result = {
            orders: open
              ? [
                  {
                    orderId: originalOrderId,
                    market: 0,
                    side: 'SIDE_BID',
                    price: '6000000000',
                    remaining: '10000000',
                    position: 'POSITION_SIDE_LONG',
                  },
                ]
              : [],
          };
          break;
        case 'GetNonce':
          result = { lastNonce: '10' };
          break;
        case 'GetAllowance':
          result = { used: '0', limit: '10000' };
          break;
        case 'GetAgents':
          result = {
            agents: [{ slot: 1, seq: 6, expiry: '0', key: `0x${Buffer.from(publicKey).toString('hex')}` }],
          };
          break;
        case 'Submit': {
          const hashes = q.params.actions.map((s) => {
            const action = decodeAction(Buffer.from(s.action.slice(2), 'hex'));
            const auth = decodeAuth(Buffer.from(s.auth.slice(2), 'hex'));
            assert.equal(
              verifyAgentSignature(publicKey, Buffer.from(genesis.slice(2), 'hex'), action, auth),
              true,
            );
            assert.equal(action.account, 7);
            assert.equal(action.orderId.toString(), originalOrderId);
            submitted.push(action);
            if (action.type === 'Cancel') open = false;
            return transactionHash(action, auth);
          });
          result = {
            id: q.params.id,
            statuses: hashes.map(() => 'SUBMIT_STATUS_ACCEPTED'),
            transactionHashes: hashes,
          };
          break;
        }
        case 'GetActionStatus':
          result = {
            statuses: q.params.keys.map((key) => ({
              key,
              state: 'ACTION_STATE_EXECUTED',
              height: '101',
              ok: true,
            })),
          };
          break;
        default:
          throw new Error(`Unexpected RPC ${method}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    APOLLO_RPC_URL: `http://127.0.0.1:${server.address().port}`,
    APOLLO_ACCOUNT: '7',
    APOLLO_AGENT_SEED: `0x${Buffer.from(seed).toString('hex')}`,
    APOLLO_GENESIS_HASH: genesis,
    APOLLO_COIN: 'BTC-USD',
    APOLLO_ORDER_ID: '',
    APOLLO_AGENT_SLOT: '1',
    APOLLO_PRICE: '61000',
    APOLLO_SIZE: '0.001',
  };
  try {
    const result = await run('open-orders', ['--order-id', originalOrderId], env);
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes(originalOrderId));
    assert.ok(result.output.includes('0.001'));
    for (const file of ['cancel', 'modify-order']) {
      const prepared = await run(file, ['--order-id', originalOrderId], env);
      assert.equal(prepared.code, 0, prepared.output);
      assert.match(prepared.output, /Not broadcast/);
      assert.equal(submitted.length, 0, 'default mode broadcast a transaction');
    }
    const callCount = calls.length;
    for (const bad of ['0', '1n', '1e3', '18446744073709551616']) {
      const result = await run('cancel', ['--order-id', bad, '--submit'], env);
      assert.notEqual(result.code, 0);
    }
    assert.equal(calls.length, callCount, 'invalid order IDs reached the node');
    const invalidSize = await run(
      'modify-order',
      ['--order-id', originalOrderId, '--size', '0.00001', '--submit'],
      env,
    );
    assert.notEqual(invalidSize.code, 0);
    assert.equal(submitted.length, 0);
    const modified = await run('modify-order', ['--order-id', originalOrderId, '--submit'], env);
    assert.equal(modified.code, 0, modified.output);
    assert.equal(submitted[0].type, 'Modify');
    const cancelled = await run('cancel', ['--order-id', originalOrderId, '--submit'], env);
    assert.equal(cancelled.code, 0, cancelled.output);
    assert.equal(submitted[1].type, 'Cancel');
    assert.match(cancelled.output, /Still open after cancellation: false/);
    const empty = await run('open-orders', ['--order-id', originalOrderId], env);
    assert.equal(empty.code, 0, empty.output);
    assert.match(empty.output, /No matching open orders/);
    const readOnly = await run('open-orders', ['--order-id', originalOrderId], {
      ...env,
      APOLLO_AGENT_SEED: '',
    });
    assert.equal(readOnly.code, 0, readOnly.output);
    for (const file of ['cancel', 'modify-order', 'open-orders']) {
      const help = await run(file, ['--help'], {
        ...env,
        APOLLO_RPC_URL: '',
        APOLLO_ACCOUNT: '',
        APOLLO_AGENT_SEED: '',
      });
      assert.equal(help.code, 0, help.output);
      assert.match(help.output, /Usage/);
    }
    for (const result of [modified, cancelled])
      assert.ok(!result.output.includes(env.APOLLO_AGENT_SEED.slice(2)), 'printed signer seed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
