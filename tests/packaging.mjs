// External-consumer verification: pack, install in a fresh project, compile,
// execute against a real local HTTP server, then bundle for a browser.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), 'apollo-sdk-consumer-'));
let submissions = 0;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/rpc?key=fixture/');
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    const method = request.method.split('.').at(-1);
    let result;
    switch (method) {
      case 'GetChainInfo':
        result = { chainId: 'package-smoke', genesisHash: `0x${'01'.repeat(32)}`, executedHeight: '42' };
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
      case 'GetNonce':
        result = { lastNonce: '0' };
        break;
      case 'GetAgents':
        result = { agents: [{ slot: 1, seq: 2, key: publicKey, expiry: '0' }] };
        break;
      case 'GetAllowance':
        result = { used: '0', limit: '10000', remaining: '10000' };
        break;
      case 'GetFills':
        result = {
          index: { firstHeight: '1', indexedHeight: '42', executedHeight: '42' },
          fills: [
            {
              height: '42',
              market: 0,
              makerAccount: '7',
              takerAccount: '8',
              makerFee: '-20',
              takerFee: '100',
            },
          ],
        };
        break;
      case 'Submit': {
        submissions++;
        const hashes = request.params.actions.map((signed) => {
          assert.equal(signed.action.length, 98);
          assert.equal(signed.auth.length, 158);
          const action = sdk.decodeAction(Uint8Array.from(Buffer.from(signed.action.slice(2), 'hex')));
          const auth = sdk.decodeAuth(Uint8Array.from(Buffer.from(signed.auth.slice(2), 'hex')));
          assert.equal(
            sdk.verifyAgentSignature(key.publicKey, new Uint8Array(32).fill(1), action, auth),
            true,
          );
          return sdk.transactionHash(action, auth);
        });
        result = {
          id: request.params.id,
          statuses: hashes.map(() => 'SUBMIT_STATUS_ACCEPTED'),
          transactionHashes: hashes,
        };
        break;
      }
      case 'GetActionStatus':
        result = {
          statuses: request.params.keys.map((key) => ({
            key,
            state: 'ACTION_STATE_EXECUTED',
            height: '43',
            ok: true,
          })),
        };
        break;
      default:
        throw new Error(`Unexpected method ${method}`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
let sdk, key, publicKey;
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`)),
    );
  });
}
try {
  const packed = JSON.parse(
    await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root),
  )[0];
  assert.ok(
    !packed.files.some((f) => /(^tests\/|node_modules|\.env|actions\.json|package-lock\.json)/.test(f.path)),
    'package contains only public artifacts',
  );
  assert.ok(packed.files.some((f) => f.path === 'dist/index.d.ts'));
  const tarball = join(temp, packed.filename);
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({ name: 'external-consumer', private: true, type: 'module' }),
  );
  await run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], temp);
  sdk = await import(new URL('../dist/index.js', import.meta.url));
  const seed = crypto.getRandomValues(new Uint8Array(32));
  key = sdk.createAgentSigner(seed, 1, 2);
  publicKey = `0x${Buffer.from(key.publicKey).toString('hex')}`;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/rpc?key=fixture/`;
  const consumer = `
import { createApolloClient, Info, Exchange, type PlaceOrderRequest, type CreateOrderRequest } from '@svpchain/trading-sdk';
import { market } from '@svpchain/trading-sdk/protocol';
const client = createApolloClient({ baseUrl: ${JSON.stringify(baseUrl)} });
const identity = await client.connect();
if (identity.chainId !== 'package-smoke') throw new Error('wrong network');
const trader = client.agent({ account: 7, seed: new Uint8Array(${JSON.stringify([...seed])}) });
const request: PlaceOrderRequest = { market: 'BTC-USD', side: 'buy', type: 'limit', price: '65000', size: '0.001' };
const receipt = await trader.placeOrder(request);
if (receipt.outcome.kind !== 'executed' || !receipt.outcome.ok) throw new Error('not executed');
if (market.MarketStatus.ACTIVE !== 2) throw new Error('protocol exports');
const info = new Info({baseUrl: ${JSON.stringify(baseUrl)}});
const meta = await info.meta();
if(meta.markets[0].ticker !== 'BTC-USD')throw new Error('Info query');
const exchange = new Exchange({baseUrl: ${JSON.stringify(baseUrl)}, account:7, signer:{type:'agent',seed:new Uint8Array(${JSON.stringify([...seed])})}});
const newRequest: CreateOrderRequest = {coin:'BTC-USD',isBuy:true,price:'65000',size:'0.001',orderType:{limit:{tif:'Gtc'}}};
const batch = await exchange.bulkOrders([newRequest,newRequest]);
if(!batch.successful() || batch.statuses.length !== 2)throw new Error('Exchange batch');
if(batch.statuses[0].prepared.nonce===batch.statuses[1].prepared.nonce)throw new Error('Duplicate batch nonce');
const changes = await exchange.bulkModify([
 {coin:'BTC-USD',orderId:batch.statuses[0].prepared.nonce,price:'65100',size:'0.001'},
 {coin:'BTC-USD',orderId:batch.statuses[1].prepared.nonce,price:'65200',size:'0.001'},
]);
if(!changes.successful() || changes.statuses.length!==2)throw new Error('Bulk modify');
const cancellation=await exchange.cancelTwap({coin:'BTC-USD',orderId:123n});
if(!cancellation.successful())throw new Error('TWAP cancel');
const fees=await info.userFees({account:7,market:0});
if(fees.summary.netFees!==-20n || fees.summary.rebates!==20n)throw new Error('Fee summary');
console.log('External consumer: Info/Exchange, batches, TWAP cancel, fee summary and client API passed');
`;
  await writeFile(join(temp, 'consumer.ts'), consumer);
  await run(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      'consumer.ts',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict',
      '--skipLibCheck',
      '--outDir',
      'out',
    ],
    temp,
  );
  console.log((await run(process.execPath, ['out/consumer.js'], temp)).trim());
  assert.equal(submissions, 4);
  const bundle = await build({
    entryPoints: [join(temp, 'consumer.ts')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  assert.ok(
    !Object.keys(bundle.metafile.inputs).some((path) => /node:|\/react\/|\/next\//.test(path)),
    'browser bundle has no server/app dependency',
  );
  console.log(`Browser bundle passed (${bundle.outputFiles[0].contents.length} bytes, unminified)`);
  console.log(`Package verified: ${packed.filename}, ${packed.entryCount} files, ${packed.size} bytes`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
