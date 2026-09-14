const API_BASE = 'https://api.hevyapp.com';
const PAGE_SIZES = { workouts: 10, routines: 10, exercise_templates: 100 };
// Workout history can reasonably exceed one thousand sessions.  This remains a
// hard stop so a broken pagination response cannot loop forever.
const MAX_PAGES = 1_000;
const TIMEOUT_MS = 20_000;
export const ROUTINE_UNCERTAIN_MESSAGE = 'Hevy may have created this routine. Sync/check Hevy before trying again.';
export const ROUTINE_UPDATE_UNCERTAIN_MESSAGE = 'Hevy may have saved these changes. Sync/check Hevy before trying again.';

export class HevyError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'HevyError';
    this.code = code;
    this.status = status ?? ({ invalid_key: 401, rate_limited: 429, network: 503, bad_response: 502, pagination_limit: 502 }[code] ?? 502);
  }
}

function collection(json, key) {
  if (Array.isArray(json?.[key])) return json[key];
  throw new HevyError('bad_response', `Hevy returned an invalid ${key} response.`);
}

function pageCount(json) {
  const count = json?.page_count;
  return Number.isInteger(count) && count >= 0 ? count : null;
}

async function routineRejection(response) {
  let detail = '';
  try {
    const json = await response.json();
    if (typeof json?.error === 'string') detail = json.error.replace(/\s+/g, ' ').trim().slice(0, 500);
  } catch { /* retain the stable fallback for malformed error responses */ }
  const message = detail ? `Hevy rejected this routine: ${detail}` : 'Hevy rejected this routine. Correct it and try again.';
  return new HevyError('routine_rejected', message, 400);
}

async function fetchJson(fetchImpl, url, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { headers: { 'api-key': apiKey, accept: 'application/json' }, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new HevyError('network', 'Hevy request timed out.');
    throw new HevyError('network', 'Could not reach Hevy.');
  }
  try {
    if (!response?.ok) {
      if (response?.status === 401 || response?.status === 403) throw new HevyError('invalid_key', 'Hevy rejected the API key.', response.status);
      if (response?.status === 429) throw new HevyError('rate_limited', 'Hevy rate limited the sync. Please try again later.', response.status);
      throw new HevyError('remote_error', `Hevy returned HTTP ${response?.status ?? 'error'}.`, response?.status);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HevyError) throw error;
    if (error?.name === 'AbortError') throw new HevyError('network', 'Hevy request timed out.');
    throw new HevyError('bad_response', 'Hevy returned invalid JSON.');
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAllPages(fetchImpl, apiKey, resource) {
  const items = [];
  const ids = new Set();
  const pageSize = PAGE_SIZES[resource];
  let expectedPageCount = null;
  if (!pageSize) throw new TypeError(`Unsupported Hevy resource: ${resource}`);
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`/v1/${resource}`, API_BASE);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    const json = await fetchJson(fetchImpl, url, apiKey);
    const batch = collection(json, resource);
    const total = pageCount(json);
    if (total === null || json.page !== page || (expectedPageCount !== null && total !== expectedPageCount)) throw new HevyError('bad_response', `Hevy returned inconsistent ${resource} pagination.`);
    expectedPageCount = total;
    // Hevy documents this exact empty-account response.  Any other zero-page
    // response or a non-empty zero-page response is unsafe to reconcile.
    if (total === 0) {
      if (page === 1 && batch.length === 0) return items;
      throw new HevyError('bad_response', `Hevy returned inconsistent ${resource} pagination.`);
    }
    if (total < page || batch.length > pageSize || (page < total && batch.length === 0)) throw new HevyError('bad_response', `Hevy returned inconsistent ${resource} pagination.`);
    for (const item of batch) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new HevyError('bad_response', `Hevy returned duplicate or invalid ${resource} ids.`);
      ids.add(item.id);
    }
    items.push(...batch);
    if (page >= total) return items;
  }
  throw new HevyError('pagination_limit', 'Hevy returned too many pages; sync was stopped safely.');
}

export async function fetchSnapshot(fetchImpl, apiKey) {
  const [workouts, routines, exerciseTemplates] = await Promise.all([
    fetchAllPages(fetchImpl, apiKey, 'workouts'),
    fetchAllPages(fetchImpl, apiKey, 'routines'),
    fetchAllPages(fetchImpl, apiKey, 'exercise_templates'),
  ]);
  return { workouts, routines, exerciseTemplates };
}

export async function fetchRoutine(fetchImpl, apiKey, id) {
  if (typeof id !== 'string' || !id) throw new TypeError('Routine id is required.');
  const json = await fetchJson(fetchImpl, `${API_BASE}/v1/routines/${encodeURIComponent(id)}`, apiKey);
  const routine = json?.routine ?? json;
  if (!routine || typeof routine !== 'object' || routine.id !== id) throw new HevyError('bad_response', 'Hevy returned an invalid routine response.');
  return routine;
}

export async function postRoutine(fetchImpl, apiKey, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/v1/routines`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new HevyError('routine_uncertain', ROUTINE_UNCERTAIN_MESSAGE, 502);
  }
  try {
    if (response?.status === 400) throw await routineRejection(response);
    if (response?.status === 401) throw new HevyError('invalid_key', 'Hevy rejected the API key.', 401);
    if (response?.status === 403) throw new HevyError('routine_limit', 'Hevy routine limit reached.', 403);
    if (response?.status === 429) throw new HevyError('rate_limited', 'Hevy rate limited the request. Please try again later.', 429);
    if (response?.status >= 500 || response?.status !== 201) throw new HevyError('routine_uncertain', ROUTINE_UNCERTAIN_MESSAGE, 502);
    const json = await response.json();
    const routine = json?.routine ?? json;
    if (!routine || typeof routine !== 'object' || typeof routine.id !== 'string' || !routine.id) throw new HevyError('routine_uncertain', ROUTINE_UNCERTAIN_MESSAGE, 502);
    return routine;
  } catch (error) {
    if (error instanceof HevyError) throw error;
    throw new HevyError('routine_uncertain', ROUTINE_UNCERTAIN_MESSAGE, 502);
  } finally {
    clearTimeout(timer);
  }
}

// Routine edits have a different endpoint and response contract from creates.
// Keep this separate so callers cannot accidentally turn an edit into a POST.
export async function updateRoutine(fetchImpl, apiKey, id, payload, confirmedFallback = null) {
  if (typeof id !== 'string' || !id) throw new TypeError('Routine id is required.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/v1/routines/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new HevyError('routine_uncertain', ROUTINE_UPDATE_UNCERTAIN_MESSAGE, 502);
  }
  try {
    if (response?.status === 400) throw await routineRejection(response);
    if (response?.status === 401) throw new HevyError('invalid_key', 'Hevy rejected the API key.', 401);
    if (response?.status === 404) throw new HevyError('routine_not_found', 'Hevy could not find this routine. Sync to refresh your routines.', 404);
    if (response?.status === 429) throw new HevyError('rate_limited', 'Hevy rate limited the request. Please try again later.', 429);
    if (response?.status === 403) throw new HevyError('routine_forbidden', 'Hevy does not allow this routine update.', 403);
    if (response?.status < 200 || response?.status >= 300) throw new HevyError('routine_uncertain', ROUTINE_UPDATE_UNCERTAIN_MESSAGE, 502);
    let json;
    try { json = await response.json(); }
    catch { return confirmedFallback ?? { id, ...payload.routine }; }
    const routine = json?.routine ?? json;
    // A 2xx response confirms the PUT even if Hevy omits its response
    // representation. Use the exact submitted routine so Corpus does not
    // encourage a duplicate retry after a successful remote write.
    if (!routine || typeof routine !== 'object' || typeof routine.id !== 'string' || !routine.id) return confirmedFallback ?? { id, ...payload.routine };
    if (routine.id !== id) throw new HevyError('routine_uncertain', ROUTINE_UPDATE_UNCERTAIN_MESSAGE, 502);
    return routine;
  } catch (error) {
    if (error instanceof HevyError) throw error;
    throw new HevyError('routine_uncertain', ROUTINE_UPDATE_UNCERTAIN_MESSAGE, 502);
  } finally {
    clearTimeout(timer);
  }
}
