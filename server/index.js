import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createService } from './service.js';
import { callAssistantTool } from './assistant-tools.js';
import { browserSessions, equalToken, loadAssistantToken } from './assistant-access.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req, maximum = 65536) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('Use application/json for this request.'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('Request must contain a JSON object.'), { status: 400 });
  }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

async function googleCallbackPage(service, url, res) {
  let status = 200; let message = 'Google Health is connected. You can close this tab and return to Corpus.';
  try {
    await service.googleHealthCallback({ code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') ?? '' });
  } catch (error) {
    const code = error.status || error.statusCode;
    status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 400;
    message = error.message || 'Google Health could not be connected.';
  }
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Corpus</title><style>body{font-family:system-ui,sans-serif;background:#f6f5f2;color:#1f2933;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;line-height:1.5}</style></head><body><main><h1>Corpus</h1><p>${escapeHtml(message)}</p></main></body></html>`);
}

export function createApp(service, { assistantToken = null } = {}) {
  const sessions = browserSessions();
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const port = req.socket.localPort;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const foreign = () => json(res, 403, { error: 'Corpus only accepts requests from its local interface.' });
    if (!hosts.has(req.headers.host)) return foreign();
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      // The OAuth loopback redirect is a top-level navigation from Google, so
      // it is exempt from the origin check; the single-use state protects it.
      if (req.method === 'GET' && path === '/api/metrics/google/callback') return googleCallbackPage(service, url, res);
      if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return foreign();
      if (path.startsWith('/api/assistant/')) {
        const token = req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
        if (!equalToken(token, assistantToken)) return json(res, 401, { error: 'A valid Corpus assistant credential is required.', code: 'assistant_unauthorized' });
        if (path === '/api/assistant/status' && req.method === 'GET') return json(res, 200, { ok: true, mode: service.getState().mode });
        const match = path.match(/^\/api\/assistant\/tools\/([a-z_]+)$/);
        if (req.method !== 'POST' || !match) return json(res, 404, { error: 'Assistant tool not found.' });
        const envelope = await body(req, 262144);
        if (Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'args') || !envelope.args || typeof envelope.args !== 'object' || Array.isArray(envelope.args)) {
          throw Object.assign(new Error('Assistant requests must contain an args object.'), { status: 400, code: 'assistant_envelope' });
        }
        return json(res, 200, await callAssistantTool(service, match[1], envelope.args));
      }
      if (req.headers.authorization) return json(res, 403, { error: 'Assistant credentials cannot access the review interface.', code: 'assistant_forbidden' });
      if (req.method === 'GET' && path === '/api/session') return json(res, 200, sessions.issue(req, res));
      if (req.method === 'GET' && /^\/api\/proposals\/[^/]+$/.test(path)) return json(res, 200, await service.getProposal(decodeURIComponent(path.split('/').at(-1))));
      const review = path.match(/^\/api\/proposals\/([^/]+)\/review$/);
      const publishLocal = path.match(/^\/api\/local-routines\/([^/]+)\/publish$/);
      if (req.method === 'POST' && (review || publishLocal || path === '/api/training-profile')) {
        if (!sessions.verify(req)) return json(res, 403, { error: 'Refresh the review session and try again.', code: 'csrf_invalid' });
        const payload = await body(req);
        const result = review ? await service.reviewProposal(decodeURIComponent(review[1]), payload)
          : publishLocal ? await service.publishLocalRoutine(decodeURIComponent(publishLocal[1]), payload)
            : await service.saveTrainingProfile(payload);
        return json(res, 200, result);
      }
      if (req.method === 'GET' && path === '/api/state') return json(res, 200, await service.getState());
      if (req.method === 'GET' && path === '/api/metrics') return json(res, 200, await service.getMetrics({ days: url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 90 }));
      if (req.method === 'GET' && path === '/api/metrics/workouts') return json(res, 200, await service.getWorkoutMetricsOverview({ days: url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 90 }));
      const workoutMetrics = path.match(/^\/api\/workouts\/([^/]+)\/metrics$/);
      if (req.method === 'GET' && workoutMetrics) return json(res, 200, await service.getWorkoutMetrics(decodeURIComponent(workoutMetrics[1])));
      // Fetching one workout's window takes no request body, so it is answered
      // before the generic JSON POST handling below.
      const workoutMetricsSync = path.match(/^\/api\/workouts\/([^/]+)\/metrics\/sync$/);
      if (req.method === 'POST' && workoutMetricsSync) {
        const workoutId = decodeURIComponent(workoutMetricsSync[1]);
        await service.syncWorkoutMetrics({ workoutIds: [workoutId], budget: 1 });
        return json(res, 200, await service.getWorkoutMetrics(workoutId));
      }
      // The literal `doses` segment must be matched before /api/supplements/:id
      // so it is never taken for a supplement id.
      if (req.method === 'GET' && path === '/api/supplements/doses') return json(res, 200, await service.getSupplementDoses({ days: url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 90 }));
      const supplementDose = path.match(/^\/api\/supplements\/([^/]+)\/doses$/);
      if (req.method === 'POST' && supplementDose) {
        const payload = await body(req);
        return json(res, 200, await service.logDose(decodeURIComponent(supplementDose[1]), payload));
      }
      if (req.method === 'POST') {
        const payload = await body(req);
        let result;
        if (path === '/api/settings') result = await service.saveSettings(payload);
        else if (path === '/api/sync') result = await service.sync();
        else if (path === '/api/metrics/sync') result = await service.syncMetrics();
        else if (path === '/api/metrics/google/connect') result = await service.googleHealthConnect({ redirectUri: `http://${req.headers.host}/api/metrics/google/callback` });
        else if (path === '/api/metrics/google/disconnect') result = await service.googleHealthDisconnect();
        else if (path === '/api/demo') {
          if (typeof payload.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean.'), { status: 400 });
          result = await service.setDemo(payload.enabled);
        } else if (path === '/api/programs') result = await service.saveProgram(payload);
        else if (path === '/api/supplements') result = await service.saveSupplement(payload);
        else if (path === '/api/routines') result = await service.createRoutine(payload);
        else if (path === '/api/export') result = await service.exportMarkdown();
        else return json(res, 404, { error: 'Not found.' });
        return json(res, 200, result ?? { ok: true });
      }
      if (req.method === 'PUT' && /^\/api\/routines\/[^/]+$/.test(path)) {
        const payload = await body(req);
        const result = await service.updateRoutine(decodeURIComponent(path.split('/').at(-1)), payload);
        return json(res, 200, result ?? { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/programs\/[^/]+$/.test(path)) {
        const result = await service.deleteProgram(decodeURIComponent(path.split('/').at(-1)));
        return json(res, 200, result ?? { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/supplements\/doses\/[^/]+$/.test(path)) return json(res, 200, await service.deleteDose(decodeURIComponent(path.split('/').at(-1))));
      if (req.method === 'DELETE' && /^\/api\/supplements\/[^/]+$/.test(path)) return json(res, 200, await service.deleteSupplement(decodeURIComponent(path.split('/').at(-1))));
      if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      const file = resolve(publicDir, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!file.startsWith(publicDir + sep) || !mime[extname(file)]) return json(res, 404, { error: 'Not found.' });
      let content;
      try { content = await readFile(file); }
      catch { return json(res, 404, { error: 'Not found.' }); }
      res.writeHead(200, { 'Content-Type': mime[extname(file)] });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = error.status || error.statusCode || 400;
      json(res, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, { error: error.message || 'The request could not be completed.', ...(error.code ? { code: error.code } : {}) });
    }
  });
}

async function main() {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const dataDir = resolve(process.env.CORPUS_DATA_DIR || resolve(root, 'data'));
  const service = await createService({ dataDir });
  const server = createApp(service, { assistantToken: await loadAssistantToken(dataDir) });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try PORT=3211 npm start.` : 'Corpus could not start its local server.');
    service.close();
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Corpus is running at http://127.0.0.1:${port}\nYour data stays in ${resolve(process.env.CORPUS_DATA_DIR || resolve(root, 'data'))}`));
  const stop = () => server.close(() => { service.close(); process.exit(0); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Corpus could not initialize. Check Node.js 24+ and that the data directory is writable.'); process.exitCode = 1; });
}
