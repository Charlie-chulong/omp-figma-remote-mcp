import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'omp-figma-test-'));
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
await mkdir(join(home, '.pi'));
await writeFile(join(home, '.pi', 'figma-remote-mcp-token.json'), JSON.stringify({
  accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token',
  clientId: 'fixture-client', expiresAt: Date.now() + 300_000,
}));
const { default: plugin } = await import('../dist/index.js');
const realFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  await rm(home, { recursive: true, force: true });
});

async function fixture(call) {
  const hooks = new Map();
  const tools = new Map();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ url, request, authorization: init.headers.Authorization });
    if (request.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' } });
    if (request.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'whoami', description: 'Read-only fixture', inputSchema: { type: 'object', properties: {} } }] } }), { headers: { 'content-type': 'application/json' } });
    return await call(request, init);
  };
  plugin({ on(name, callback) { hooks.set(name, callback); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} });
  const context = { ui: { notify(message) { assert.fail(message); }, setStatus() {} } };
  await hooks.get('session_start')({}, context);
  return { tool: tools.get('whoami'), requests, close: () => hooks.get('session_shutdown')({}, context) };
}

test('transport failures report safe causes without logging request arguments or credentials and do not replay', async () => {
  let fail = true;
  const f = await fixture(async (request) => {
    if (fail) throw new TypeError('fetch failed for https://secret.invalid/?token=message-secret', { cause: Object.assign(new Error('authorization-secret'), { code: 'ECONNRESET' }) });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'success' }] } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await f.tool.execute('one', { sensitive: 'argument-secret' }, undefined);
    assert.equal(result.isError, true);
    assert.deepEqual(result.details.figmaFailure, { stage: 'http-request', causes: 'TypeError <- Error[ECONNRESET]' });
    assert.doesNotMatch(JSON.stringify(result), /fixture-access-token|message-secret|authorization-secret|argument-secret|secret\.invalid/);
    assert.equal(f.requests.filter(r => r.request.method === 'tools/call').length, 1);
    fail = false;
    assert.equal((await f.tool.execute('two', {}, undefined)).isError, false);
    assert.equal(f.requests.at(-1).authorization, 'Bearer fixture-access-token');
  } finally { f.close(); }
});

test('remote JSON-RPC fetch failures are distinguished from local transport failures', async () => {
  const f = await fixture(async request => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fetch failed' } }), { headers: { 'content-type': 'application/json' } }));
  try {
    const result = await f.tool.execute('one', {}, undefined);
    assert.equal(result.isError, true);
    assert.deepEqual(result.details.figmaFailure, { stage: 'json-rpc', code: -32603 });
    assert.equal(f.requests.filter(r => r.request.method === 'tools/call').length, 1);
  } finally { f.close(); }
});

test('explicit cancellation is not mislabeled a network failure and never replayed', async () => {
  const controller = new AbortController();
  const f = await fixture(async (_request, init) => { init.signal.throwIfAborted(); assert.fail('cancelled request passed the signal boundary'); });
  try {
    controller.abort(new Error('explicit cancellation'));
    const result = await f.tool.execute('one', {}, controller.signal);
    assert.equal(result.isError, true);
    assert.equal(result.details, undefined);
    assert.equal(f.requests.filter(r => r.request.method === 'tools/call').length, 1);
  } finally { f.close(); }
});

test('genuine HTTP 401 retains the existing authentication-required boundary', async () => {
  const f = await fixture(async request => {
    if (request.method === 'tools/call') return new Response('', { status: 401 });
    assert.fail('unexpected request');
  });
  const fetchMcp = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('/oauth/token') ? new Response('', { status: 401 }) : await fetchMcp(url, init);
  try {
    const result = await f.tool.execute('one', {}, undefined);
    assert.equal(result.isError, true);
    assert.equal(result.details, undefined);
    assert.equal(f.requests.filter(r => r.request.method === 'tools/call').length, 1);
  } finally { f.close(); }
});
