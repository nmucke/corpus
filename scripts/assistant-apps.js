import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assistantOrigin } from '../server/mcp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function desktopSetup({ env = process.env, rootDir = root, node = process.execPath } = {}) {
  const dataDir = path.resolve(rootDir, env.CORPUS_DATA_DIR?.trim() || 'data');
  const origin = assistantOrigin(env.CORPUS_ASSISTANT_URL?.trim() || `http://127.0.0.1:${env.PORT?.trim() || 3210}`);
  return {
    rootDir,
    dataDir,
    origin,
    node,
    bridge: path.join(rootDir, 'server', 'mcp-local.js'),
    archive: path.join(dataDir, 'assistant-apps', 'corpus-assistant-claude.zip'),
  };
}

export function installedClaudeManifest(base, setup) {
  const manifest = structuredClone(base);
  delete manifest.userConfig;
  manifest.mcpServers = {
    corpus: {
      command: setup.node,
      args: [setup.bridge],
      cwd: setup.rootDir,
      env: { CORPUS_ASSISTANT_URL: setup.origin, CORPUS_DATA_DIR: setup.dataDir },
    },
  };
  return manifest;
}

export async function buildClaudePlugin({ env = process.env, rootDir = root, node = process.execPath, outputPath } = {}) {
  const setup = desktopSetup({ env, rootDir, node });
  const destination = outputPath || setup.archive;
  const staging = await mkdtemp(path.join(os.tmpdir(), 'corpus-assistant-plugin-'));
  const plugin = path.join(staging, 'corpus-assistant');
  const candidate = path.join(staging, 'corpus-assistant-claude.zip');
  try {
    await cp(path.join(rootDir, 'plugins', 'corpus-assistant'), plugin, { recursive: true });
    const manifestFile = path.join(plugin, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await writeFile(manifestFile, `${JSON.stringify(installedClaudeManifest(manifest, setup), null, 2)}\n`, { mode: 0o600 });
    const zipped = spawnSync('zip', ['-qr', candidate, 'corpus-assistant'], { cwd: staging, encoding: 'utf8' });
    if (zipped.error || zipped.status !== 0) throw new Error('Could not package the Claude plugin. Install the zip command and retry.');
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(candidate, destination);
    await chmod(destination, 0o600);
    return { ...setup, archive: destination };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) throw new Error('Usage: npm run assistant:setup');
  const setup = await buildClaudePlugin();
  console.log(`Local desktop assistant setup\n\nKeep Corpus running with: npm start\n\nChatGPT Desktop → Settings → MCP servers → Add server\nName: Corpus\nType: STDIO\nCommand: ${setup.node}\nArguments: ${setup.bridge}\nWorking directory: ${setup.rootDir}\nEnvironment: CORPUS_ASSISTANT_URL=${setup.origin}, CORPUS_DATA_DIR=${setup.dataDir}\n\nClaude Desktop → Cowork → Customize → Plugins → Upload plugin\nPlugin file: ${setup.archive}\n\nRestart the desktop app after installing. No assistant launcher is needed after this one-time setup.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
