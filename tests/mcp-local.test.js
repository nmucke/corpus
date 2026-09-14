import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localAssistantConfig } from '../server/mcp-local.js';

test('desktop MCP loads the local credential and full training instructions', async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-mcp-local-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const dataDir = path.join(rootDir, 'private-data');
  const assistantDir = path.join(rootDir, 'assistant');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(assistantDir, { recursive: true }),
  ]);
  const token = 'a'.repeat(64);
  await writeFile(path.join(dataDir, 'assistant-token'), `${token}\n`);
  await writeFile(path.join(assistantDir, 'AGENTS.md'), 'Use only Corpus MCP tools.');
  const config = await localAssistantConfig({ rootDir, cwd: rootDir, env: { CORPUS_DATA_DIR: 'private-data', PORT: '4321' } });
  assert.equal(config.token, token);
  assert.equal(config.dataDir, dataDir);
  assert.equal(config.origin, 'http://127.0.0.1:4321');
  assert.equal(config.instructions, 'Use only Corpus MCP tools.');
});

test('desktop MCP refuses missing and malformed local credentials', async t => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-mcp-local-invalid-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, 'assistant'), { recursive: true });
  await writeFile(path.join(rootDir, 'assistant', 'AGENTS.md'), 'Corpus instructions');
  await assert.rejects(localAssistantConfig({ rootDir, cwd: rootDir, env: {} }), /Start Corpus/);
  await assert.rejects(localAssistantConfig({ rootDir, cwd: rootDir, env: { CORPUS_ASSISTANT_TOKEN: 'bad' } }), /invalid local assistant credential/);
});
