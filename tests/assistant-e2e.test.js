import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createService } from '../server/service.js';
import { createApp } from '../server/index.js';

test('desktop stdio bridge loads its local credential and submits a browser-reviewed draft', { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-mcp-e2e-'));
  const service = await createService({ dataDir });
  const token = 'b'.repeat(64);
  await writeFile(path.join(dataDir, 'assistant-token'), `${token}\n`, { mode: 0o600 });
  const server = createApp(service, { assistantToken: token });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); await rm(dataDir, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [path.resolve('server/mcp-local.js')], { env: { ...process.env, CORPUS_ASSISTANT_URL: origin, CORPUS_DATA_DIR: dataDir, CORPUS_ASSISTANT_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map();
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  const rpc = (method, params) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'corpus-test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'corpus-assistant');
  const catalog = await rpc('tools/list', {});
  assert.ok(catalog.result.tools.some(x => x.name === 'corpus_submit_proposal'));
  assert.equal(catalog.result.tools.some(x => /accept|publish/.test(x.name)), false);
  const submitted = await rpc('tools/call', { name: 'corpus_submit_proposal', arguments: {
    requestId: '7c067b34-d807-485c-bcbd-822833e42d5d', title: 'Stdio plan', rationale: 'A test draft.',
    routines: [{ key: 'squat', routine: { title: 'Stdio squat', exercises: [{ exercise_template_id: 'demo-squat', sets: [{ type: 'normal', reps: 5 }] }] } }], programs: [],
  } });
  assert.equal(submitted.result.isError, undefined);
  const proposal = JSON.parse(submitted.result.content[0].text);
  assert.equal(proposal.status, 'draft');
  assert.equal(service.getState().routines.some(x => x.title === 'Stdio squat'), false);
  const reviewPath = `${origin}/api/proposals/${proposal.id}/review`;
  const payload = JSON.stringify({ action: 'accept', expectedRevision: proposal.revision });
  const forbidden = await fetch(reviewPath, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload });
  assert.equal(forbidden.status, 403);
  const session = await fetch(`${origin}/api/session`);
  const { csrfToken } = await session.json();
  const accepted = await fetch(reviewPath, { method: 'POST', headers: { cookie: session.headers.get('set-cookie').split(';')[0], 'x-corpus-csrf': csrfToken, 'content-type': 'application/json' }, body: payload });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status, 'accepted');
  assert.equal(service.getState().routines.find(x => x.title === 'Stdio squat').source, 'local');
  child.stdin.end(); await once(child, 'exit');
});
