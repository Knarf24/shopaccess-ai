import {
  DEFAULT_APP_ORIGIN, POLL_DELAYS_MS, approvalUrl, beginPairing, completionStatus, conversationReplaced, createAnnouncer, createApi,
  createTurnIds, ensureInstallationId, errorCode, normalizeAppOrigin, replyAnnouncement, restoreFocus, runPairingPoll, settleSubmit,
} from './client.mjs';

// ShopAccess side panel (M2-2). The bearer lives in chrome.storage.session (cleared when the browser closes); the app
// address and installation ID live in chrome.storage.local. The panel never shows prices and has no confirm, checkout
// or payment action. Language follows the draft (D-M22-4); the panel does not switch it.
const $ = (id) => document.getElementById(id);
const session = chrome.storage.session;
const local = chrome.storage.local;
const lock = { pending: false };
const announcer = createAnnouncer($('announce'));
const turnIds = createTurnIds();
let origin = normalizeAppOrigin((await local.get('appOrigin')).appOrigin) ?? DEFAULT_APP_ORIGIN;
let access = (await session.get('access')).access ?? null;
let view = null;
let pollTimer = null;
let pairGeneration = 0;
let announced = false;
let replies = 0;
// Where focus goes once controls are enabled again (a disabled control cannot take focus during the request).
let focusAfter = null;

const WORDS = {
  en: {
    notice: 'Reads and continues your shopping conversation. Confirming, checkout and payment stay on the website.',
    skip: 'Skip to conversation', connection: 'Connection', originLabel: 'ShopAccess address', saveOrigin: 'Save address',
    pair: 'Pair with website', refresh: 'Refresh conversation', disconnect: 'Forget local pairing', heading: 'Conversation',
    message: 'Message', send: 'Send', working: 'Working…', saved: 'Saved.', you: 'You: ', assistant: 'Assistant: ',
    failed: 'Request failed. Refresh, or pair again.', notPaired: 'Not paired. Select Pair with website.',
    rateLimited: 'Too many messages in the last minute. Wait, then send again; your message is kept.',
    approve: 'Approve conversation-only access on the website tab that opened.', paired: 'Paired. Conversation access only.',
    expired: 'Pairing expired. Start again.', stopped: 'Pairing stopped. Start again.', denied: 'Pairing was denied on the website.',
    forgot: 'Local credential removed. To end server access, revoke it on the website under Paired access.',
    originSaved: 'Address saved. Pair again for this address.', originInvalid: 'Enter http://127.0.0.1 with a port, or an https address, with no path.',
    noDraft: 'No current shopping conversation. Start one on the website.', stale: 'The conversation changed. It has been refreshed; your message is kept.',
    pairedLoadFailed: 'Paired, but the conversation could not be loaded. Select Refresh conversation; do not pair again.',
    confirmed: (use, budget) => `Confirmed on the website: ${use}, budget $${budget}.`, notConfirmed: 'Not confirmed yet. Confirm on the website.',
    allowlist: (id) => 'Extension origin for the server allowlist: chrome-extension://' + id,
    uses: { programming: 'programming', schoolwork: 'schoolwork', general_productivity: 'general productivity' },
  },
  es: {
    notice: 'Lee y continúa su conversación de compra. Confirmar, pagar y finalizar la compra se hacen en el sitio web.',
    skip: 'Ir a la conversación', connection: 'Conexión', originLabel: 'Dirección de ShopAccess', saveOrigin: 'Guardar dirección',
    pair: 'Vincular con el sitio', refresh: 'Actualizar conversación', disconnect: 'Olvidar vínculo local', heading: 'Conversación',
    message: 'Mensaje', send: 'Enviar', working: 'Procesando…', saved: 'Guardado.', you: 'Usted: ', assistant: 'Asistente: ',
    failed: 'La solicitud falló. Actualice o vuelva a vincular.', notPaired: 'Sin vincular. Seleccione Vincular con el sitio.',
    rateLimited: 'Demasiados mensajes en el último minuto. Espere y vuelva a enviar; su mensaje se conserva.',
    approve: 'Apruebe el acceso solo a la conversación en la pestaña del sitio que se abrió.', paired: 'Vinculado. Solo acceso a la conversación.',
    expired: 'La vinculación caducó. Empiece de nuevo.', stopped: 'La vinculación se detuvo. Empiece de nuevo.', denied: 'La vinculación fue rechazada en el sitio.',
    forgot: 'Credencial local eliminada. Para terminar el acceso en el servidor, revóquelo en el sitio, en Accesos vinculados.',
    originSaved: 'Dirección guardada. Vuelva a vincular para esta dirección.', originInvalid: 'Escriba http://127.0.0.1 con un puerto, o una dirección https, sin ruta.',
    noDraft: 'No hay una conversación de compra actual. Empiece una en el sitio.', stale: 'La conversación cambió. Se actualizó; su mensaje se conserva.',
    pairedLoadFailed: 'Vinculado, pero no se pudo cargar la conversación. Seleccione Actualizar conversación; no vuelva a vincular.',
    confirmed: (use, budget) => `Confirmado en el sitio: ${use}, presupuesto $${budget}.`, notConfirmed: 'Aún sin confirmar. Confirme en el sitio.',
    allowlist: (id) => 'Origen de la extensión para la lista del servidor: chrome-extension://' + id,
    uses: { programming: 'programación', schoolwork: 'tareas escolares', general_productivity: 'productividad general' },
  },
};
const language = () => (view?.draft?.language === 'es' ? 'es' : 'en');
const words = () => WORDS[language()];

// The server no longer accepts the token (revoked, expired or session ended): forget it and stop showing the conversation.
async function dropAccess() {
  access = null;
  await session.remove('access');
  announcer.clear();
  view = null;
  replies = 0;
  $('history').replaceChildren();
  $('summary').textContent = '';
}
// Built per call so a saved address change applies to the next request.
const call = (path, body) => createApi({ origin, bearer: () => access?.bearer ?? null, onUnauthorized: dropAccess })(path, body);

function labels() {
  const w = words();
  document.documentElement.lang = language();
  for (const [id, key] of [['notice', 'notice'], ['skip', 'skip'], ['connection-heading', 'connection'], ['origin-label', 'originLabel'], ['save-origin', 'saveOrigin'], ['pair', 'pair'], ['refresh', 'refresh'], ['disconnect', 'disconnect'], ['heading', 'heading'], ['text-label', 'message'], ['send', 'send']]) $(id).textContent = w[key];
  $('extension-id').textContent = w.allowlist(chrome.runtime.id);
}

function render(next) {
  if (conversationReplaced(view, next)) announcer.clear();
  const said = replyAnnouncement(view, next, replies + 1);
  view = next;
  labels();
  const w = words();
  const draft = view?.draft ?? null;
  $('summary').textContent = !draft ? w.noDraft : draft.confirmedUse && draft.confirmedBudgetDollars ? w.confirmed(w.uses[draft.confirmedUse] ?? draft.confirmedUse, draft.confirmedBudgetDollars) : w.notConfirmed;
  $('history').replaceChildren(...(view?.conversation?.turns ?? []).map((turn) => {
    const li = document.createElement('li');
    li.textContent = (turn.role === 'shopper' ? w.you : w.assistant) + turn.text;
    return li;
  }));
  $('send').disabled = !draft;
  if (said && announcer.say(said)) {
    replies += 1;
    announced = true;
  }
}

async function refresh() {
  render(await call('/conversation'));
}

async function action(fn) {
  const before = document.activeElement;
  await settleSubmit(lock, async () => {
    focusAfter = null;
    announced = false;
    $('error').textContent = '';
    $('status').textContent = words().working;
    const controls = document.querySelectorAll('button,input,textarea');
    for (const el of controls) el.disabled = true;
    try {
      const message = await fn();
      $('status').textContent = message ?? completionStatus(announced, words().saved);
    } catch (e) {
      $('status').textContent = '';
      const code = errorCode(e);
      const explanation = code === 'STALE_DRAFT' ? words().stale : code === 'RATE_LIMITED' ? words().rateLimited : access ? words().failed : words().notPaired;
      $('error').textContent = explanation + ' (' + code + ')';
    } finally {
      for (const el of controls) el.disabled = false;
      $('send').disabled = !view?.draft;
      // After a refusal that ended access, Send stays disabled: recovery starts at Pair with website.
      if (focusAfter?.isConnected && !focusAfter.disabled) focusAfter.focus();
      else restoreFocus(before, document, () => (access ? $('text') : $('pair')));
    }
  });
}

async function poll() {
  const generation = pairGeneration;
  const active = () => generation === pairGeneration;
  const { pairing } = await session.get('pairing');
  if (!pairing || !active()) return;
  if (pairing.polls >= POLL_DELAYS_MS.length || Date.now() >= pairing.expiresAt) {
    await session.remove('pairing');
    $('status').textContent = words().expired;
    return;
  }
  pairing.polls += 1;
  await session.set({ pairing });
  if (!active()) return;
  try {
    const outcome = await runPairingPoll({
      pairing,
      active,
      status: (p) => call(`/pairings/${p.pairingId}/status`, { exchangeSecret: p.exchangeSecret }),
      exchange: (p) => call(`/pairings/${p.pairingId}/exchange`, { exchangeSecret: p.exchangeSecret, verifier: p.verifier }),
      store: async (value) => {
        const stored = { bearer: value.bearer, grantId: value.grantId, expiresAt: value.expiresAt, origin };
        await session.set({ access: stored });
        if (active()) access = stored;
      },
      clear: async (value) => {
        const current = (await session.get('access')).access;
        if (current?.bearer === value.bearer) await session.remove('access');
      },
    });
    if (!active() || outcome === 'cancelled') return;
    if (outcome === 'paired') {
      await session.remove('pairing');
      $('status').textContent = words().paired;
      try {
        await refresh();
      } catch (e) {
        $('error').textContent = words().pairedLoadFailed + ' (' + errorCode(e) + ')';
      }
      return;
    }
    if (outcome === 'denied') {
      await session.remove('pairing');
      $('error').textContent = words().denied;
      return;
    }
    pollTimer = setTimeout(poll, POLL_DELAYS_MS[pairing.polls] ?? 0);
  } catch {
    if (active()) {
      await session.remove('pairing');
      $('error').textContent = words().stopped;
    }
  }
}

async function forgetLocal() {
  pairGeneration += 1;
  announcer.clear();
  clearTimeout(pollTimer);
  await session.remove(['access', 'pairing']);
  access = null;
  view = null;
  replies = 0;
  $('history').replaceChildren();
  $('summary').textContent = '';
}

$('origin').value = origin;
$('origin-form').onsubmit = (event) => {
  event.preventDefault();
  void action(async () => {
    const next = normalizeAppOrigin($('origin').value);
    if (!next) throw new Error('ORIGIN_INVALID');
    // Host access for exactly this origin, if the shopper allows it. Requests also work by CORS without it.
    await chrome.permissions.request({ origins: [next + '/*'] }).catch(() => false);
    if (next !== origin) await forgetLocal();
    origin = next;
    await local.set({ appOrigin: next });
    $('origin').value = next;
    return words().originSaved;
  }).then(() => {
    if ($('error').textContent.includes('ORIGIN_INVALID')) $('error').textContent = words().originInvalid;
  });
};
$('pair').onclick = () =>
  action(async () => {
    // The approval page opens in the current draft's language; read it before forgetting the local view.
    const pairingLanguage = language();
    await forgetLocal();
    const installationId = await ensureInstallationId(local);
    const pairing = await beginPairing({ api: call, session, installationId });
    await chrome.tabs.create({ url: approvalUrl(origin, pairing.pairingId, pairingLanguage) });
    pollTimer = setTimeout(poll, POLL_DELAYS_MS[0]);
    return words().approve;
  });
$('refresh').onclick = () => action(refresh);
$('disconnect').onclick = () =>
  action(async () => {
    await forgetLocal();
    return words().forgot;
  });
$('turn-form').onsubmit = (event) => {
  event.preventDefault();
  void action(async () => {
    if (!view?.draft) await refresh();
    const draft = view?.draft;
    if (!draft) return words().noDraft;
    const text = $('text').value.trim();
    try {
      const next = await call('/conversation/turns', { draftId: draft.draftId, version: draft.version, shopperText: text, clientRequestId: turnIds.idFor(draft.draftId, draft.version, text) });
      turnIds.settled();
      render({ draft: next.draft, conversation: next.conversation });
      $('text').value = '';
      focusAfter = $('text');
    } catch (e) {
      // A stale draft is refreshed so the next send uses the current version; the unsent text stays in the field.
      if (errorCode(e) === 'STALE_DRAFT') await refresh().catch(() => {});
      throw e;
    }
  });
};
window.addEventListener('pagehide', () => clearTimeout(pollTimer));

labels();
if (access && access.origin === origin) await action(refresh);
else if ((await session.get('pairing')).pairing) pollTimer = setTimeout(poll, POLL_DELAYS_MS[0]);
else $('status').textContent = words().notPaired;
