import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantOrigin, createMcpHandler, handleLine } from '../server/mcp.js';

test('MCP initializes, lists tools, and ignores initialized notification', async () => {
  const handler = createMcpHandler({ token: 'opaque-token', origin: 'http://127.0.0.1:3210', fetchImpl: async () => new Response('{}') });
  const initialized = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(initialized.result.protocolVersion, '2025-03-26');
  assert.match(initialized.result.instructions, /human review/);
  assert.equal((await handler({ jsonrpc: '2.0', method: 'notifications/initialized' })), undefined);
  const tools = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(tools.result.tools.some((tool) => tool.name === 'corpus_workflow'));
  assert.equal(tools.result.tools.find((tool) => tool.name === 'corpus_summary').annotations.readOnlyHint, true);
  assert.equal(tools.result.tools.find((tool) => tool.name === 'corpus_submit_proposal').annotations.readOnlyHint, false);
  assert.ok(tools.result.tools.every((tool) => tool.annotations.destructiveHint === false && tool.annotations.openWorldHint === false));
});

test('MCP accepts current lifecycle versions and negotiates a supported fallback', async () => {
  const handler = createMcpHandler({ token: 'opaque-token', origin: 'http://127.0.0.1:3210', fetchImpl: async () => new Response('{}') });
  for (const protocolVersion of ['2024-11-05', '2025-06-18', '2025-11-25']) {
    const result = await handler({ jsonrpc: '2.0', id: protocolVersion, method: 'initialize', params: { protocolVersion } });
    assert.equal(result.result.protocolVersion, protocolVersion);
  }
  const result = await handler({ jsonrpc: '2.0', id: 'newer', method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(result.result.protocolVersion, '2025-11-25');
});

test('MCP calls only known local tools and does not disclose bearer credentials', async () => {
  let request;
  const handler = createMcpHandler({ token: 'opaque-token', origin: 'http://127.0.0.1:3210', fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ profile: { summary: 'ok' } }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const result = await handler({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'corpus_get_profile', arguments: {} } });
  assert.match(request.url, /\/api\/assistant\/tools\/corpus_get_profile$/);
  assert.equal(request.options.headers.authorization, 'Bearer opaque-token');
  assert.deepEqual(JSON.parse(request.options.body), { args: {} });
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(result.result.content[0].text.includes('opaque-token'), false);
  assert.deepEqual(result.result.structuredContent, { profile: { summary: 'ok' } });
  const bad = await handler({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'fs.read', arguments: {} } });
  assert.equal(bad.error.code, -32602);
});

test('MCP rejects malformed and oversized newline JSON input and loopback validation is strict', async () => {
  const handler = createMcpHandler({ token: 'opaque-token', origin: 'http://127.0.0.1:3210', fetchImpl: async () => new Response('{}') });
  assert.equal((await handleLine('{bad', handler)).error.code, -32700);
  assert.equal((await handleLine('x'.repeat(256 * 1024 + 1), handler)).error.code, -32700);
  assert.throws(() => assistantOrigin('https://127.0.0.1:3210'));
  assert.throws(() => assistantOrigin('http://example.com'));
  assert.throws(() => assistantOrigin('http://127.0.0.1:3210/not-an-origin'));
});
