// ShopAccess side panel helpers (M2-2, docs/m2-2-plan.md §3.5 and §3.6). Promoted from the E1 prototype (274866d).
// Pure functions and small factories only, so they run under the unit tests without a browser.

export const DEFAULT_APP_ORIGIN = 'http://127.0.0.1:3000';
export const API_PREFIX = '/api/extension/v1';
/** Waits between pairing status checks. Ten checks at most (the server's limit), within the five-minute pairing. */
export const POLL_DELAYS_MS = [5000, 5000, 10000, 10000, 15000, 20000, 30000, 40000, 60000, 90000];

/** The app origin the shopper set: loopback HTTP for local testing, otherwise HTTPS. Exact origin only, no path. */
export function normalizeAppOrigin(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url.origin;
  if (url.protocol === 'https:' && url.hostname.includes('.')) return url.origin;
  return null;
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** One random installation ID per browser profile, kept in chrome.storage.local. Re-pairing replaces this installation's grant. */
export async function ensureInstallationId(local, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const { installationId } = await local.get('installationId');
  if (typeof installationId === 'string' && /^ins_[0-9a-f]{32}$/.test(installationId)) return installationId;
  const created = 'ins_' + hex(random(16));
  await local.set({ installationId: created });
  return created;
}

export async function verifierAndChallenge(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const verifier = hex(random(32));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: hex(new Uint8Array(digest)) };
}

/**
 * Calls the extension API at `origin`. Never sends cookies, never follows redirects. A refusal throws Error(code);
 * 401 also calls onUnauthorized so the panel forgets a token the server no longer accepts.
 */
export function createApi({ origin, bearer, fetchImpl = fetch, onUnauthorized = async () => {} }) {
  return async function api(path, body) {
    const url = new URL(API_PREFIX + path, origin);
    if (url.origin !== origin) throw new Error('ORIGIN_DENIED');
    const token = bearer();
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let out;
    try {
      out = await response.json();
    } catch {
      throw new Error('BAD_RESPONSE');
    }
    if (!out || out.ok !== true) {
      if (response.status === 401) await onUnauthorized();
      throw new Error(typeof out?.code === 'string' && /^[A-Z_]+$/.test(out.code) ? out.code : 'BAD_RESPONSE');
    }
    return out.value;
  };
}

/** Starts a pairing and keeps what the panel needs to finish it in session storage. */
export async function beginPairing({ api, session, installationId, random = undefined }) {
  const { verifier, challenge } = await verifierAndChallenge(random);
  const started = await api('/pairings', { protocolVersion: 1, challenge, installationId });
  const pairing = { pairingId: started.pairingId, exchangeSecret: started.exchangeSecret, expiresAt: started.expiresAt, verifier, polls: 0 };
  await session.set({ pairing });
  return pairing;
}

export function approvalUrl(origin, pairingId, language) {
  const url = new URL('/extension/pair', origin);
  url.searchParams.set('pairing', pairingId);
  url.searchParams.set('lang', language === 'es' ? 'es' : 'en');
  return url.href;
}

/** One status check; on approval, exchange and store. `active()` false at any await means a newer pairing or Forget won. */
export async function runPairingPoll({ pairing, active, status, exchange, store, clear = async () => {} }) {
  const result = await status(pairing);
  if (!active()) return 'cancelled';
  if (result.status !== 'approved') return result.status;
  const access = await exchange(pairing);
  if (!active()) return 'cancelled';
  await store(access);
  if (!active()) {
    await clear(access);
    return 'cancelled';
  }
  return 'paired';
}

export async function settleSubmit(lock, action) {
  if (lock.pending) return false;
  lock.pending = true;
  try {
    await action();
    return true;
  } finally {
    lock.pending = false;
  }
}

/**
 * The same clientRequestId for a retry of the same message on the same draft version, so a lost response is not sent
 * twice. A different message or version gets a new ID.
 */
export function createTurnIds(random = () => crypto.randomUUID()) {
  let last = null;
  return {
    idFor(draftId, version, text) {
      const key = draftId + '\u0000' + version + '\u0000' + text;
      if (last?.key !== key) last = { key, id: random() };
      return last.id;
    },
    settled() {
      last = null;
    },
  };
}

// Disabling the focused control during a request moves focus to <body>. Return it to the control the user was on,
// or to `fallback()` when that control is gone or is still disabled (a disabled control cannot take focus).
export function restoreFocus(before, doc = document, fallback) {
  const current = doc.activeElement;
  if (current && current !== doc.body) return false;
  if (!before || before === doc.body) return false;
  const usable = (el) => !!el && el.isConnected && !el.disabled;
  if (usable(before)) {
    before.focus();
    return true;
  }
  const target = typeof fallback === 'function' ? fallback() : null;
  if (!usable(target)) return false;
  target.focus();
  return true;
}

/** True when the panel now shows a different draft's conversation than before. */
export function conversationReplaced(prev, next) {
  return !!prev?.draft && !!next?.draft && prev.draft.draftId !== next.draft.draftId;
}

/**
 * Text for the newest assistant line that arrived since `prev`, numbered by the caller (VoiceOver did not repeat an
 * identical live-region message in E1). Nothing on first load, an unchanged refresh or a different draft.
 */
export function replyAnnouncement(prev, next, number) {
  if (!prev?.draft || !next?.draft || prev.draft.draftId !== next.draft.draftId) return null;
  const before = prev.conversation?.turns ?? [];
  const after = next.conversation?.turns ?? [];
  if (after.length === 0 || JSON.stringify(before) === JSON.stringify(after)) return null;
  const last = after.at(-1);
  if (last.role !== 'assistant') return null;
  return (next.conversation.interfaceLanguage === 'es' ? 'Respuesta del asistente ' : 'Assistant reply ') + number + ': ' + last.text;
}

// One pending announcement at a time: a newer message, Forget, re-pair or a draft change cancels the delayed one and
// clears the region. The short delay makes each message a distinct region update.
export function createAnnouncer(region, { schedule = (fn) => setTimeout(fn, 150), cancel = (id) => clearTimeout(id) } = {}) {
  let pending = null;
  function clear() {
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
    region.textContent = '';
  }
  return {
    say(text) {
      clear();
      if (!text) return false;
      pending = schedule(() => {
        pending = null;
        region.textContent = text;
      });
      return true;
    },
    clear,
  };
}

export function completionStatus(announced, generic) {
  return announced ? '' : generic;
}

export const errorCode = (e) => (typeof e?.message === 'string' && /^[A-Z_]+$/.test(e.message) ? e.message : 'LOCAL_ERROR');
