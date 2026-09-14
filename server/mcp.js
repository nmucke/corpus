import { ASSISTANT_TOOLS } from './assistant-tools.js';

const MAX_INPUT_BYTES = 256 * 1024;
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export const DEFAULT_SERVER_INSTRUCTIONS = 'Corpus training assistant. Work only through the Corpus MCP tools. Start with corpus_summary and keep queries bounded. Use corpus_workflow for the relevant detailed workflow. Never approve, decline, publish, sync, change settings, access files, execute SQL, or call Hevy. corpus_submit_proposal only saves a draft for human review.';

const TOOL_TITLES = Object.freeze({
  corpus_summary: 'Summarize Corpus training data',
  corpus_search_exercises: 'Search exercise templates',
  corpus_list_routines: 'List routines',
  corpus_get_routine: 'Get routine details',
  corpus_list_programs: 'List programs',
  corpus_get_program: 'Get program details',
  corpus_workout_summary: 'Summarize workout progress',
  corpus_muscle_coverage: 'Analyze muscle coverage',
  corpus_list_proposals: 'List training proposals',
  corpus_get_proposal: 'Get proposal details',
  corpus_submit_proposal: 'Save a draft proposal',
  corpus_get_profile: 'Get training profile',
  corpus_workflow: 'Load a Corpus workflow',
});

export const MCP_TOOLS = Object.freeze(ASSISTANT_TOOLS.map((tool) => Object.freeze({
  ...tool,
  title: TOOL_TITLES[tool.name],
  annotations: Object.freeze({
    readOnlyHint: tool.name !== 'corpus_submit_proposal',
    destructiveHint: false,
    idempotentHint: tool.name !== 'corpus_submit_proposal',
    openWorldHint: false,
  }),
})));

export function assistantOrigin(value = process.env.CORPUS_ASSISTANT_URL || 'http://127.0.0.1:3210') {
  let url;
  try { url = new URL(value); } catch { throw new Error('CORPUS_ASSISTANT_URL must be a loopback HTTP origin.'); }
  // The bridge intentionally has no generic URL capability. A path, query,
  // credentials, or HTTPS URL would make the target less auditable.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('CORPUS_ASSISTANT_URL must be a loopback HTTP origin.');
  }
  return url.origin;
}

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function failure(id, code, message, data = undefined) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function isRequest(value) { return isObject(value) && value.jsonrpc === '2.0' && typeof value.method === 'string'; }
function toolResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}
function toolByName(name) { return ASSISTANT_TOOLS.find((tool) => tool.name === name); }

export function createMcpHandler({ fetchImpl = globalThis.fetch, origin = assistantOrigin(), token = process.env.CORPUS_ASSISTANT_TOKEN, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, instructions = DEFAULT_SERVER_INSTRUCTIONS } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required.');
  if (typeof token !== 'string' || !token.trim()) throw new Error('CORPUS_ASSISTANT_TOKEN is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be an integer from 1 to 60000.');
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 16_000) throw new TypeError('instructions must be non-empty text no longer than 16000 characters.');
  const target = assistantOrigin(origin);
  return async function handle(message) {
    if (!isRequest(message)) return failure(message?.id, -32600, 'Invalid Request.');
    const notification = !Object.hasOwn(message, 'id');
    const { id, method, params } = message;
    if (!notification && typeof id !== 'string' && typeof id !== 'number') return failure(null, -32600, 'Invalid Request.');
    if (method === 'notifications/initialized') return undefined;
    if (method === 'initialize') {
      if (!isObject(params) || typeof params.protocolVersion !== 'string') return failure(id, -32602, 'Invalid MCP initialization request.');
      // MCP lifecycle negotiation calls for a server to choose a supported
      // version when the client offers an unknown revision; the client then
      // decides whether it can continue with that version.
      const protocolVersion = PROTOCOL_VERSIONS.has(params.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
      return response(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'corpus-assistant', version: '0.1.0' }, instructions });
    }
    if (method === 'ping') return notification ? undefined : response(id, {});
    if (method === 'tools/list') return notification ? undefined : response(id, { tools: MCP_TOOLS });
    if (method !== 'tools/call') return notification ? undefined : failure(id, -32601, 'Method not found.');
    if (!isObject(params) || typeof params.name !== 'string' || !toolByName(params.name) || (params.arguments !== undefined && !isObject(params.arguments))) return notification ? undefined : failure(id, -32602, 'Invalid tool request.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const endpoint = `${target}/api/assistant/tools/${encodeURIComponent(params.name)}`;
      const remote = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ args: params.arguments ?? {} }),
        redirect: 'error',
        signal: controller.signal,
      });
      let payload = null;
      try { payload = await remote.json(); } catch { /* translated below */ }
      if (!remote.ok || !isObject(payload)) {
        const messageText = typeof payload?.error === 'string' ? payload.error.slice(0, 500) : 'Corpus assistant tool could not complete the request.';
        return notification ? undefined : response(id, toolResult({ error: messageText }, true));
      }
      return notification ? undefined : response(id, toolResult(payload));
    } catch {
      // Do not surface fetch diagnostics: they can contain the origin or token.
      return notification ? undefined : response(id, toolResult({ error: 'Corpus assistant tool is unavailable.' }, true));
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function handleLine(line, handler) {
  if (Buffer.byteLength(line, 'utf8') > MAX_INPUT_BYTES) return failure(null, -32700, 'Request exceeds the 256KB input limit.');
  let message;
  try { message = JSON.parse(line); } catch { return failure(null, -32700, 'Parse error.'); }
  return handler(message);
}

export async function runStdio({ input = process.stdin, output = process.stdout, error = process.stderr, handler = createMcpHandler() } = {}) {
  let pending = '';
  input.setEncoding('utf8');
  for await (const chunk of input) {
    pending += chunk;
    if (Buffer.byteLength(pending, 'utf8') > MAX_INPUT_BYTES && !pending.includes('\n')) {
      output.write(`${JSON.stringify(failure(null, -32700, 'Request exceeds the 256KB input limit.'))}\n`); pending = ''; continue;
    }
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
      if (!line) continue;
      const result = await handleLine(line, handler);
      if (result !== undefined) output.write(`${JSON.stringify(result)}\n`);
    }
  }
  if (pending.trim()) {
    const result = await handleLine(pending, handler);
    if (result !== undefined) output.write(`${JSON.stringify(result)}\n`);
  }
  error.write('Corpus MCP stdin closed.\n');
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname) {
  runStdio().catch(() => { process.stderr.write('Corpus MCP could not start.\n'); process.exitCode = 1; });
}
