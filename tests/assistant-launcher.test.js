import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { clientEnvironment, codexArguments, claudeArguments, verifyCodexServers, prepareWorkspace } from '../scripts/assistant.js';

test('training launch preserves native login paths and drops API billing credentials', () => {
  const env = clientEnvironment({ HOME: '/native-home', CODEX_HOME: '/native-codex', PATH: '/bin', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', HEVY_API_KEY: 'secret', CLAUDE_CODE_USE_BEDROCK: '1' }, 'http://127.0.0.1:3210', 'draft-token');
  assert.equal(env.HOME, '/native-home'); assert.equal(env.CODEX_HOME, '/native-codex');
  assert.equal(env.PATH, '/bin'); assert.equal(env.CORPUS_ASSISTANT_TOKEN, 'draft-token');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'HEVY_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']) assert.equal(env[key], undefined);
});

test('Codex removes inherited MCP capabilities and fails closed when isolation is unverified', () => {
  const args = codexArguments({ workspace: '/tmp/training', instructions: 'Training only', servers: [{ name: 'general-tools' }], features: new Set(['shell_tool', 'unified_exec', 'plugins']), node: '/node', mcp: '/mcp' });
  assert.ok(args.includes('mcp_servers.general-tools.enabled=false'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('features.unified_exec=false'));
  assert.ok(args.includes('features.plugins=false'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
  assert.throws(() => codexArguments({ servers: [], features: new Set() }), /restrictions/);
  assert.throws(() => codexArguments({ servers: [{ name: 'corpus' }], features: new Set(['shell_tool']) }), /existing/);
  const corpus = { name: 'corpus', enabled: true, transport: { command: '/node', args: ['/mcp'] } };
  verifyCodexServers([corpus, { name: 'general-tools', enabled: false }], '/node', '/mcp');
  assert.throws(() => verifyCodexServers([corpus, { name: 'general-tools', enabled: true }], '/node', '/mcp'), /isolate/);
  assert.throws(() => verifyCodexServers([{ ...corpus, transport: { command: '/other', args: ['/mcp'] } }], '/node', '/mcp'), /isolate/);
});

test('runtime workspace contains training instructions and skills without credentials or repository source', async () => {
  const workspace = await prepareWorkspace();
  try {
    assert.match(await readFile(`${workspace}/AGENTS.md`, 'utf8'), /Corpus training assistant/);
    assert.match(await readFile(`${workspace}/.claude/skills/corpus-design-routine/SKILL.md`, 'utf8'), /corpus-design-routine/);
    assert.match(await readFile(`${workspace}/.agents/skills/corpus-design-program/SKILL.md`, 'utf8'), /corpus-design-program/);
    const config = JSON.parse(await readFile(`${workspace}/mcp.json`, 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers), ['corpus']);
    assert.equal(config.mcpServers.corpus.env, undefined);
    await assert.rejects(stat(`${workspace}/server`), { code: 'ENOENT' });
    const args = claudeArguments({ workspace, instructions: 'Training only' });
    assert.equal(args[args.indexOf('--tools') + 1], 'Skill,AskUserQuestion');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
    const settings = JSON.parse(await readFile(`${workspace}/settings.json`, 'utf8'));
    assert.ok(settings.permissions.deny.includes('Bash'));
    assert.equal(settings.disableAllHooks, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
