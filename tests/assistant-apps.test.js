import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopSetup, installedClaudeManifest } from '../scripts/assistant-apps.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('desktop setup uses local absolute paths without exposing the assistant token', () => {
  const setup = desktopSetup({ rootDir: '/opt/corpus', node: '/opt/node', env: { PORT: '4321', CORPUS_DATA_DIR: 'private' } });
  assert.deepEqual(setup, {
    rootDir: '/opt/corpus',
    dataDir: '/opt/corpus/private',
    origin: 'http://127.0.0.1:4321',
    node: '/opt/node',
    bridge: '/opt/corpus/server/mcp-local.js',
    archive: '/opt/corpus/private/assistant-apps/corpus-assistant-claude.zip',
  });
  assert.equal(JSON.stringify(setup).includes('ASSISTANT_TOKEN'), false);
});

test('packaged Claude manifest replaces prompts with local bridge configuration', () => {
  const base = { name: 'corpus-assistant', userConfig: { corpus_root: {} }, mcpServers: {} };
  const setup = desktopSetup({ rootDir: '/opt/corpus', node: '/opt/node', env: {} });
  const manifest = installedClaudeManifest(base, setup);
  assert.equal(manifest.userConfig, undefined);
  assert.deepEqual(manifest.mcpServers.corpus, {
    command: '/opt/node',
    args: ['/opt/corpus/server/mcp-local.js'],
    cwd: '/opt/corpus',
    env: { CORPUS_ASSISTANT_URL: 'http://127.0.0.1:3210', CORPUS_DATA_DIR: '/opt/corpus/data' },
  });
});

test('desktop plugin workflows stay identical to the isolated assistant workflows', async () => {
  for (const name of ['corpus-analyze-training', 'corpus-design-program', 'corpus-design-routine', 'corpus-revise-proposal']) {
    const canonical = await readFile(path.join(root, 'assistant', '.agents', 'skills', name, 'SKILL.md'), 'utf8');
    const plugin = await readFile(path.join(root, 'plugins', 'corpus-assistant', 'skills', name, 'SKILL.md'), 'utf8');
    assert.equal(plugin, canonical, `${name} differs from its canonical workflow`);
  }
});
