import { spawn, spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assistantOrigin } from '../server/mcp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(root, 'server/mcp.js');
const disabledFeatures = new Set([
  'shell_tool', 'unified_exec', 'shell_snapshot', 'code_mode', 'code_mode_host',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'apps', 'plugins', 'remote_plugin', 'recommended_plugins', 'multi_agent', 'multi_agent_v2',
  'hooks', 'skill_mcp_dependency_install', 'skill_search', 'view_image', 'image_generation',
  'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'workspace_dependencies',
  'request_permissions_tool', 'js_repl', 'apply_patch_freeform',
]);

export function clientEnvironment(env, origin, token) {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (/^(OPENAI_|ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_SIMPLE|HEVY_API_KEY|CODEX_INTERNAL_|CODEX_REMOTE_)/.test(key)) delete result[key];
  }
  // Preserve native subscription login locations; never redirect HOME/CODEX_HOME.
  return { ...result, CORPUS_ASSISTANT_URL: origin, CORPUS_ASSISTANT_TOKEN: token };
}

export function codexArguments({ workspace, instructions, servers, features, node = process.execPath, mcp = bridge }) {
  if (!Array.isArray(servers) || servers.some(s => typeof s.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(s.name)) || !features.has('shell_tool')) throw new Error('This Codex CLI cannot verify the required tool restrictions. Update Codex and use simple MCP server names before trying again.');
  if (servers.some(s => s.name === 'corpus')) throw new Error('An existing Codex MCP server is named corpus. Rename it before using the isolated Corpus launcher.');
  const args = ['-C', workspace, '--sandbox', 'read-only', '--ask-for-approval', 'never'];
  const config = (key, value) => args.push('-c', `${key}=${JSON.stringify(value)}`);
  config('forced_login_method', 'chatgpt');
  config('model_provider', 'openai');
  config('web_search', 'disabled');
  config('developer_instructions', instructions);
  config('skills.max_context_tokens', 1800);
  for (const name of disabledFeatures) if (features.has(name)) config(`features.${name}`, false);
  // TOML tables merge with global config; setting mcp_servers={} does not clear it.
  for (const server of servers) {
    // Plugin-supplied servers may not have a bootstrap config entry. Supplying
    // only enabled=false would create an invalid entry before plugin loading.
    const prefix = `mcp_servers.${server.name}`;
    if (server.transport?.type === 'streamable_http') config(`${prefix}.url`, 'http://127.0.0.1:1');
    else config(`${prefix}.command`, node);
    config(`${prefix}.enabled`, false);
  }
  config('mcp_servers.corpus.command', node);
  config('mcp_servers.corpus.args', [mcp]);
  config('mcp_servers.corpus.env_vars', ['CORPUS_ASSISTANT_URL', 'CORPUS_ASSISTANT_TOKEN']);
  config('mcp_servers.corpus.cwd', workspace);
  config('mcp_servers.corpus.enabled', true);
  config('mcp_servers.corpus.required', true);
  return args;
}

export function verifyCodexServers(servers, node = process.execPath, mcp = bridge) {
  const active = servers.filter(s => s.enabled);
  if (active.length !== 1 || active[0].name !== 'corpus' || active[0].transport?.command !== node || JSON.stringify(active[0].transport.args) !== JSON.stringify([mcp])) throw new Error('Codex did not isolate its MCP servers. The training session was not started.');
}

export function claudeArguments({ workspace, instructions }) {
  return ['--tools', 'Skill,AskUserQuestion', '--strict-mcp-config', '--mcp-config', path.join(workspace, 'mcp.json'),
    '--setting-sources', 'project', '--settings', path.join(workspace, 'settings.json'),
    '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__corpus__*,Skill,AskUserQuestion',
    '--no-chrome', '--append-system-prompt', instructions];
}

function capture(client, args, options) {
  const result = spawnSync(client, args, { ...options, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error?.code === 'ENOENT') throw new Error(`Install ${client === 'claude' ? 'Claude Code' : 'Codex CLI'} and sign in with your personal subscription first.`);
  if (result.error || result.status !== 0) throw new Error(`${client} could not verify its launch configuration. Update the CLI and check its native login before retrying.`);
  return result.stdout;
}

export async function prepareWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'corpus-assistant-'));
  await chmod(workspace, 0o700);
  await cp(path.join(root, 'assistant'), workspace, { recursive: true, dereference: true });
  await chmod(workspace, 0o700);
  await writeFile(path.join(workspace, 'mcp.json'), JSON.stringify({ mcpServers: { corpus: { command: process.execPath, args: [bridge] } } }, null, 2), { mode: 0o600 });
  await writeFile(path.join(workspace, 'settings.json'), JSON.stringify({
    permissions: { allow: ['mcp__corpus__*', 'Skill', 'AskUserQuestion'], deny: ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch'] },
    enabledPlugins: {}, disableAllHooks: true,
  }, null, 2), { mode: 0o600 });
  return workspace;
}

export async function main(argv = process.argv.slice(2)) {
  const [client, check] = argv;
  if (!['codex', 'claude'].includes(client) || (check !== undefined && check !== '--check') || argv.length > 2) throw new Error('Usage: node scripts/assistant.js codex|claude [--check]');
  const origin = assistantOrigin(process.env.CORPUS_ASSISTANT_URL || `http://127.0.0.1:${process.env.PORT || 3210}`);
  const dataDir = path.resolve(process.env.CORPUS_DATA_DIR || path.join(root, 'data'));
  let token;
  try { token = (await readFile(path.join(dataDir, 'assistant-token'), 'utf8')).trim(); }
  catch { throw new Error('Start Corpus with npm start first. Use the same CORPUS_DATA_DIR for the server and launcher.'); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Corpus has an invalid assistant credential.');
  let health;
  try { health = await fetch(`${origin}/api/assistant/status`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) }); }
  catch { throw new Error('Corpus is not reachable. Start npm start and check PORT / CORPUS_ASSISTANT_URL.'); }
  if (!health.ok) throw new Error('Restart Corpus with the latest code and the same CORPUS_DATA_DIR as this launcher.');
  const state = await health.json();
  const workspace = await prepareWorkspace();
  try {
    const env = clientEnvironment(process.env, origin, token);
    const options = { cwd: workspace, env };
    const instructions = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
    let args;
    if (client === 'codex') {
      const servers = JSON.parse(capture(client, ['mcp', 'list', '--json'], options));
      const featureText = capture(client, ['features', 'list'], options);
      const features = new Set(featureText.split('\n').map(line => line.trim().split(/\s+/)[0]));
      args = codexArguments({ workspace, instructions, servers, features });
      verifyCodexServers(JSON.parse(capture(client, [...args, 'mcp', 'list', '--json'], options)));
      const effective = capture(client, [...args, 'features', 'list'], options);
      for (const line of effective.split('\n')) {
        const parts = line.trim().split(/\s+/);
        // Some CLI builds report unified_exec=true even with its override off.
        // shell_tool=false disables both shell backends (tools/tool_config.rs).
        if (disabledFeatures.has(parts[0]) && parts[0] !== 'unified_exec' && parts.at(-1) === 'true') throw new Error(`Codex could not disable ${parts[0]}. Session not started.`);
      }
    } else {
      const help = capture(client, ['--help'], options);
      for (const flag of ['--tools', '--strict-mcp-config', '--setting-sources', '--permission-mode', '--no-chrome']) if (!help.includes(flag)) throw new Error(`Update Claude Code: ${flag} is required by the Corpus launcher.`);
      args = claudeArguments({ workspace, instructions });
    }
    console.log(`Corpus training assistant · ${state.mode} data · ${origin}/#proposals`);
    if (check) { console.log(`${client} launch configuration verified. No AI session started.`); return; }
    console.log('Use your subscription login. Review drafts in Corpus; publish to Hevy separately.');
    console.log('The selected training context is sent to your AI provider. Exit this session to return to development.');
    const child = spawn(client, args, { ...options, stdio: 'inherit' });
    // Keep the temporary workspace until the native session has fully exited.
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
