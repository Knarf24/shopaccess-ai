import {
  DEFAULT_APP_ORIGIN, POLL_DELAYS_MS, approvalUrl, beginPairing, completionStatus, conversationReplaced, createAnnouncer, createApi,
  createTurnIds, ensureInstallationId, errorCode, matchCodeDisplay, normalizeAppOrigin, replyAnnouncement, restoreFocus, runPairingPoll,
  settleSubmit,
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
let pendingPairing = false;
let refreshTimer = null;
let closed = false;
let viewGeneration = 0;
// Where focus goes once controls are enabled again (a disabled control cannot take focus during the request).
let focusAfter = null;

const WORDS = {
  en: {
    notice: 'Chat about your ShopAccess shopping. Purchases stay on the website.',
    skip: 'Skip to conversation', connection: 'Connection', originLabel: 'ShopAccess address', saveOrigin: 'Save address',
    pair: 'Connect to ShopAccess', refresh: 'Refresh conversation', disconnect: 'Disconnect locally', heading: 'Conversation',
    message: 'Message', send: 'Send', working: 'Working…', saved: 'Saved.', you: 'You: ', assistant: 'Assistant: ',
    failed: 'Could not load the conversation. Try Refresh conversation in Settings.', notPaired: 'Connect to your ShopAccess conversation to get started.',
    rateLimited: 'Too many messages in the last minute. Wait, then send again; your message is kept.',
    approve: 'On the website tab that opened, enter the pairing code shown below to allow conversation-only access.', paired: 'Paired. Conversation access only.',
    settings: 'Settings', technical: 'Advanced setup', connected: 'Connected', disconnected: 'Not connected', waiting: 'Waiting for website approval', cancelPair: 'Cancel connection', welcomeHeading: 'Your shopping assistant', welcome: 'Connect to your ShopAccess conversation to ask questions and keep shopping here.', placeholder: 'Ask about your shopping…', composerHelp: 'Enter to send · Shift+Enter for a new line', sending: 'Sending…', disconnectHelp: 'To end server access too, revoke it on the website under Paired access.',
    codeHeading: 'Pairing code',
    codeHelp: 'Enter this code only on the ShopAccess approval page that this panel opened. Never share it. It expires with this pairing.',
    expired: 'Pairing expired. Start again.', stopped: 'Pairing stopped. Start again.', denied: 'Pairing was denied on the website.',
    forgot: 'Local credential removed. To end server access, revoke it on the website under Paired access.',
    originSaved: 'Address saved. Pair again for this address.', originInvalid: 'Enter http://127.0.0.1 with a port, or an https address, with no path.',
    noDraft: 'No current shopping conversation. Start one on the website.', stale: 'The conversation changed. It has been refreshed; your message is kept.',
    pairedLoadFailed: 'Connected, but the conversation could not be loaded. Try Refresh conversation in Settings; do not connect again.',
    confirmed: (use, budget) => `Confirmed on the website: ${use}, budget $${budget}.`, notConfirmed: 'Not confirmed yet. Confirm on the website.',
    allowlist: (id) => 'Extension origin for the server allowlist: chrome-extension://' + id,
    uses: { programming: 'programming', schoolwork: 'schoolwork', general_productivity: 'general productivity' },
  },
  es: {
    notice: 'Converse sobre sus compras en ShopAccess. Las compras se confirman y pagan en el sitio web.',
    skip: 'Ir a la conversación', connection: 'Conexión', originLabel: 'Dirección de ShopAccess', saveOrigin: 'Guardar dirección',
    pair: 'Conectar con ShopAccess', refresh: 'Actualizar conversación', disconnect: 'Desconectar localmente', heading: 'Conversación',
    message: 'Mensaje', send: 'Enviar', working: 'Procesando…', saved: 'Guardado.', you: 'Usted: ', assistant: 'Asistente: ',
    failed: 'No se pudo cargar la conversación. Pruebe Actualizar conversación en Ajustes.', notPaired: 'Conecte su conversación de ShopAccess para empezar.',
    rateLimited: 'Demasiados mensajes en el último minuto. Espere y vuelva a enviar; su mensaje se conserva.',
    approve: 'En la pestaña del sitio que se abrió, escriba el código de vinculación que se muestra abajo para permitir el acceso solo a la conversación.', paired: 'Vinculado. Solo acceso a la conversación.',
    settings: 'Ajustes', technical: 'Configuración avanzada', connected: 'Conectado', disconnected: 'Sin conexión', waiting: 'Esperando aprobación en el sitio', cancelPair: 'Cancelar conexión', welcomeHeading: 'Su asistente de compras', welcome: 'Conecte su conversación de ShopAccess para hacer preguntas y seguir comprando aquí.', placeholder: 'Pregunte sobre sus compras…', composerHelp: 'Intro para enviar · Mayús+Intro para una nueva línea', sending: 'Enviando…', disconnectHelp: 'Para terminar también el acceso al servidor, revóquelo en el sitio, en Accesos vinculados.',
    codeHeading: 'Código de vinculación',
    codeHelp: 'Escriba este código solo en la página de aprobación de ShopAccess que abrió este panel. No lo comparta nunca. Caduca con esta vinculación.',
    expired: 'La vinculación caducó. Empiece de nuevo.', stopped: 'La vinculación se detuvo. Empiece de nuevo.', denied: 'La vinculación fue rechazada en el sitio.',
    forgot: 'Credencial local eliminada. Para terminar el acceso en el servidor, revóquelo en el sitio, en Accesos vinculados.',
    originSaved: 'Dirección guardada. Vuelva a vincular para esta dirección.', originInvalid: 'Escriba http://127.0.0.1 con un puerto, o una dirección https, sin ruta.',
    noDraft: 'No hay una conversación de compra actual. Empiece una en el sitio.', stale: 'La conversación cambió. Se actualizó; su mensaje se conserva.',
    pairedLoadFailed: 'Conectado, pero no se pudo cargar la conversación. Pruebe Actualizar conversación en Ajustes; no vuelva a conectar.',
    confirmed: (use, budget) => `Confirmado en el sitio: ${use}, presupuesto $${budget}.`, notConfirmed: 'Aún sin confirmar. Confirme en el sitio.',
    allowlist: (id) => 'Origen de la extensión para la lista del servidor: chrome-extension://' + id,
    uses: { programming: 'programación', schoolwork: 'tareas escolares', general_productivity: 'productividad general' },
  },
};
const language = () => (view?.draft?.language === 'es' ? 'es' : 'en');
const words = () => WORDS[language()];

// Finding 3: the pending pairing's matching code, shown only while that pairing is pending.
function showCode(pairing) {
  const shown = matchCodeDisplay(pairing?.matchCode);
  if (!shown) return hideCode();
  $('pair-code-heading').textContent = words().codeHeading;
  $('pair-code-visual').textContent = shown.visual;
  $('pair-code-spoken').textContent = shown.spoken;
  $('pair-code-help').textContent = words().codeHelp;
  // Settings is an overlay: close it so the matching code cannot be covered.
  $('settings').open = false;
  $('pair-code-box').hidden = false;
  pendingPairing = true;
  updateUi();
}
function hideCode() {
  const hadFocus = $('pair-code-box').contains(document.activeElement);
  pendingPairing = false;
  $('pair-code-box').hidden = true;
  $('pair-code-visual').textContent = '';
  $('pair-code-spoken').textContent = '';
  updateUi();
  if (hadFocus) (access ? $('heading') : $('pair')).focus();
}

// The server no longer accepts the token (revoked, expired or session ended): forget it and stop showing the conversation.
async function dropAccess() {
  clearTimeout(refreshTimer);
  access = null;
  await session.remove('access');
  const hadFocus = $('conversation').contains(document.activeElement);
  announcer.clear();
  view = null;
  replies = 0;
  $('history').replaceChildren();
  $('summary').textContent = '';
  updateUi();
  if (hadFocus) $('pair').focus();
}
// Built per call so a saved address change applies to the next request.
const call = (path, body) => {
  const requestedOrigin = origin;
  const requestedAccess = access;
  return createApi({ origin: requestedOrigin, bearer: () => requestedAccess?.bearer ?? null,
    onUnauthorized: async () => { if (access === requestedAccess && origin === requestedOrigin) await dropAccess(); },
  })(path, body);
};

function updateUi() {
  const w = words();
  $('welcome').hidden = Boolean(access) || pendingPairing;
  $('conversation').hidden = !access;
  $('pair').hidden = Boolean(access) || pendingPairing;
  $('connection-state').textContent = access ? w.connected : pendingPairing ? w.waiting : w.disconnected;
  $('skip').href = access ? '#heading' : '#main';
}

// Background reads are side-effect-free POSTs. They never send text or move focus.
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (access && !closed) refreshTimer = setTimeout(backgroundRefresh, 15000);
}
async function backgroundRefresh() {
  if (!access || closed) return;
  if (lock.pending || document.hidden) return scheduleRefresh();
  try { await refresh(); }
  catch { if (!access) $('error').textContent = words().notPaired; }
  finally { scheduleRefresh(); }
}

function labels() {
  const w = words();
  document.documentElement.lang = language();
  for (const [id, key] of [['notice', 'notice'], ['skip', 'skip'], ['connection-heading', 'connection'], ['origin-label', 'originLabel'], ['save-origin', 'saveOrigin'], ['pair', 'pair'], ['refresh', 'refresh'], ['disconnect', 'disconnect'], ['heading', 'heading'], ['text-label', 'message'], ['send', 'send'], ['settings-label', 'settings'], ['technical-label', 'technical'], ['cancel-pair', 'cancelPair'], ['welcome-heading', 'welcomeHeading'], ['welcome-text', 'welcome'], ['disconnect-help', 'disconnectHelp']]) $(id).textContent = w[key];
  $('extension-id').textContent = w.allowlist(chrome.runtime.id);
  $('text').placeholder = w.placeholder;
  $('composer-help').textContent = w.composerHelp;
  updateUi();
}

function render(next) {
  const scroller = $('chat-scroll');
  const following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const firstLoad = !view;
  const previousTurns = view?.conversation?.turns ?? [];
  const nextTurns = next?.conversation?.turns ?? [];
  const changed = JSON.stringify(previousTurns) !== JSON.stringify(nextTurns);
  if (conversationReplaced(view, next)) announcer.clear();
  const said = replyAnnouncement(view, next, replies + 1);
  view = next;
  labels();
  const w = words();
  const draft = view?.draft ?? null;
  $('summary').textContent = !draft ? w.noDraft : draft.confirmedUse && draft.confirmedBudgetDollars ? w.confirmed(w.uses[draft.confirmedUse] ?? draft.confirmedUse, draft.confirmedBudgetDollars) : w.notConfirmed;
  if (changed) $('history').replaceChildren(...nextTurns.map((turn) => {
    const li = document.createElement('li');
    li.className = turn.role === 'shopper' ? 'shopper' : 'assistant';
    li.textContent = (turn.role === 'shopper' ? w.you : w.assistant) + turn.text;
    return li;
  }));
  if (changed && (firstLoad || following)) scroller.scrollTop = scroller.scrollHeight;
  $('send').disabled = !draft;
  scheduleRefresh();
  if (said && announcer.say(said)) {
    replies += 1;
    announced = true;
  }
}

async function refresh() {
  // A POST so that Chrome always sends the extension's Origin (the originless GET read is retired).
  const credential = access;
  const address = origin;
  const generation = pairGeneration;
  const viewVersion = viewGeneration;
  const next = await call('/conversation', {});
  if (access === credential && origin === address && pairGeneration === generation && viewGeneration === viewVersion) render(next);
}

async function action(fn) {
  const before = document.activeElement;
  await settleSubmit(lock, async () => {
    clearTimeout(refreshTimer);
    viewGeneration += 1;
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
      scheduleRefresh();
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
    hideCode();
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
      hideCode();
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
      hideCode();
      $('error').textContent = words().denied;
      return;
    }
    pollTimer = setTimeout(poll, POLL_DELAYS_MS[pairing.polls] ?? 0);
  } catch {
    if (active()) {
      await session.remove('pairing');
      hideCode();
      $('error').textContent = words().stopped;
    }
  }
}

async function forgetLocal() {
  pairGeneration += 1;
  announcer.clear();
  clearTimeout(pollTimer);
  clearTimeout(refreshTimer);
  await session.remove(['access', 'pairing']);
  hideCode();
  access = null;
  view = null;
  replies = 0;
  $('history').replaceChildren();
  $('summary').textContent = '';
  updateUi();
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
$('pair').onclick = () => {
  // Ask on the direct user gesture, for the saved exact origin only. CORS remains the existing fallback if denied.
  const hostAccess = chrome.permissions.request({ origins: [origin + '/*'] }).catch(() => false);
  return action(async () => {
    await hostAccess;
    // The approval page opens in the current draft's language; read it before forgetting the local view.
    const pairingLanguage = language();
    await forgetLocal();
    const installationId = await ensureInstallationId(local);
    const pairing = await beginPairing({ api: call, session, installationId });
    showCode(pairing);
    focusAfter = $('pair-code-heading');
    try {
      await chrome.tabs.create({ url: approvalUrl(origin, pairing.pairingId, pairingLanguage) });
    } catch (e) {
      // No approval tab: abandon this pairing and stop showing its code.
      await session.remove('pairing');
      hideCode();
      throw e;
    }
    pollTimer = setTimeout(poll, POLL_DELAYS_MS[0]);
    return words().approve;
  });
};
$('refresh').onclick = () => action(refresh);
$('disconnect').onclick = () =>
  action(async () => {
    await forgetLocal();
    return words().forgot;
  });
$('cancel-pair').onclick = () => action(async () => {
  await forgetLocal();
  focusAfter = $('pair');
  return words().stopped;
});
$('turn-form').onsubmit = (event) => {
  event.preventDefault();
  if (lock.pending || !$('text').value.trim()) return;
  void action(async () => {
    if (!view?.draft) await refresh();
    const draft = view?.draft;
    if (!draft) return words().noDraft;
    const text = $('text').value.trim();
    $('pending-message').textContent = words().you + text + '\n' + words().sending;
    $('pending-message').hidden = false;
    $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight;
    try {
      const next = await call('/conversation/turns', { draftId: draft.draftId, version: draft.version, shopperText: text, clientRequestId: turnIds.idFor(draft.draftId, draft.version, text) });
      turnIds.settled();
      render({ draft: next.draft, conversation: next.conversation });
      $('text').value = '';
      if ($('text').style) $('text').style.height = '';
      $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight;
      focusAfter = $('text');
    } catch (e) {
      // A stale draft is refreshed so the next send uses the current version; the unsent text stays in the field.
      if (errorCode(e) === 'STALE_DRAFT') await refresh().catch(() => {});
      throw e;
    } finally {
      $('pending-message').hidden = true;
      $('pending-message').textContent = '';
    }
  });
};
$('text').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!lock.pending && !$('send').disabled && $('text').value.trim()) $('turn-form').requestSubmit();
  }
};
$('text').oninput = () => {
  $('text').style.height = 'auto';
  $('text').style.height = Math.min($('text').scrollHeight, 128) + 'px';
};
$('settings').onkeydown = (event) => {
  if (event.key === 'Escape' && $('settings').open) { $('settings').open = false; $('settings-label').focus(); }
};
window.addEventListener('pagehide', () => { closed = true; clearTimeout(pollTimer); clearTimeout(refreshTimer); });

labels();
if (access && (access.origin !== origin || Date.now() >= access.expiresAt)) await dropAccess();
if (access && access.origin === origin) await action(refresh);
else if ((await session.get('pairing')).pairing) {
  const pending = (await session.get('pairing')).pairing;
  if (Date.now() >= pending.expiresAt || pending.polls >= POLL_DELAYS_MS.length) {
    await session.remove('pairing');
    hideCode();
    $('status').textContent = words().expired;
  } else {
    showCode(pending);
    pollTimer = setTimeout(poll, POLL_DELAYS_MS[0]);
  }
}
else $('status').textContent = words().notPaired;
