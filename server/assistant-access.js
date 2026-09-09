import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadAssistantToken(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'assistant-token');
  try {
    const token = (await readFile(file, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid assistant credential file.');
    await chmod(file, 0o600);
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    try { await writeFile(file, `${token}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') return loadAssistantToken(dataDir); throw error; }
    return token;
  }
}

export function equalToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected || actual.length !== expected.length) return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Browser review credentials are independent of the MCP draft-only credential.
// Never return them on the assistant endpoint or include them in training state.
export function browserSessions() {
  const sessions = new Map();
  const ttl = 12 * 60 * 60 * 1000;
  function existing(req) {
    const cookie = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('corpus_session='));
    const id = cookie?.slice('corpus_session='.length);
    const session = sessions.get(id);
    return session && session.expires > Date.now() ? { id, ...session } : null;
  }
  return {
    issue(req, res) {
      let session = existing(req);
      if (!session) {
        for (const [id, item] of sessions) if (item.expires <= Date.now()) sessions.delete(id);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        session = { id: randomBytes(24).toString('hex'), csrfToken: randomBytes(32).toString('hex'), expires: Date.now() + ttl };
        sessions.set(session.id, { csrfToken: session.csrfToken, expires: session.expires });
      }
      res.setHeader('Set-Cookie', `corpus_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl / 1000}`);
      return { csrfToken: session.csrfToken };
    },
    verify(req) { return equalToken(req.headers['x-corpus-csrf'], existing(req)?.csrfToken); },
  };
}
