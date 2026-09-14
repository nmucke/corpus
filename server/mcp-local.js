import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assistantOrigin, createMcpHandler, runStdio } from './mcp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export async function localAssistantConfig({ env = process.env, rootDir = root, cwd = rootDir } = {}) {
  const dataDir = path.resolve(cwd, env.CORPUS_DATA_DIR?.trim() || path.join(rootDir, 'data'));
  let token = env.CORPUS_ASSISTANT_TOKEN?.trim();
  if (!token) {
    try { token = (await readFile(path.join(dataDir, 'assistant-token'), 'utf8')).trim(); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Start Corpus with npm start before connecting the desktop assistant.');
      throw error;
    }
  }
  if (!TOKEN_PATTERN.test(token)) throw new Error('Corpus has an invalid local assistant credential.');
  const origin = assistantOrigin(env.CORPUS_ASSISTANT_URL?.trim() || `http://127.0.0.1:${env.PORT?.trim() || 3210}`);
  const instructions = await readFile(path.join(rootDir, 'assistant', 'AGENTS.md'), 'utf8');
  return { dataDir, token, origin, instructions };
}

export async function runLocalStdio(options = {}) {
  const config = await localAssistantConfig(options);
  return runStdio({ ...options, handler: createMcpHandler(config) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runLocalStdio().catch((error) => {
    process.stderr.write(`${error.message || 'Corpus local MCP could not start.'}\n`);
    process.exitCode = 1;
  });
}
