export const ORIGIN='http://127.0.0.1:3764';
export async function settleSubmit(lock,action){if(lock.pending)return false;lock.pending=true;try{await action();return true;}finally{lock.pending=false;}}
export async function beginPairing({api,storage}){const verifier=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));const challenge=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');const b=await api('/api/extension/v1/pairings',{protocolVersion:1,challenge});const pairing={...b,verifier,polls:0};await storage.set({pairing});return pairing;}
export async function loadAccess(storage){return (await storage.get('access')).access??null;}

export async function recoverStale(action,refresh){try{return await action();}catch(e){if(e.message==='STALE_REVISION')await refresh();throw e;}}
export async function runPairingPoll({pairing,active,status,exchange,store,clear=async()=>{}}){const result=await status(pairing);if(!active())return 'cancelled';if(result.status!=='approved')return result.status;const access=await exchange(pairing);if(!active())return 'cancelled';await store(access);if(!active()){await clear(access);return 'cancelled';}return 'paired';}

// Disabling the focused control during a request moves focus to <body>. Return it to the control the user was on.
// If that control was removed by a re-render (for example a revoked grant's button), focus `fallback()` instead.
export function restoreFocus(before,doc=document,fallback){const current=doc.activeElement;if(current&&current!==doc.body)return false;if(!before||before===doc.body)return false;if(before.isConnected){before.focus();return true;}const target=typeof fallback==='function'?fallback():null;if(!target||!target.isConnected)return false;target.focus();return true;}

// Screen-reader announcements. History (#history) is not a live region, so a new reply or a revocation is otherwise silent.
// Announce only the newest assistant reply that arrived since the previous state (by sequence, which survives the eight-line trim),
// never on first load, an unchanged refresh, a language-only change or a different conversation.
export function replyAnnouncement(prev,next){if(!prev||!next||prev.conversationId!==next.conversationId)return null;const seen=prev.turns.at(-1)?.sequence??0;const reply=next.turns.filter(t=>t.role==='assistant'&&t.sequence>seen).at(-1);if(!reply)return null;const n=Math.ceil(reply.sequence/2);return (next.interfaceLanguage==='es'?'Respuesta del asistente '+n+': ':'Assistant reply '+n+': ')+reply.text;}
// Names the revoked pairing by the same eight-character label its Revoke button shows, and says what access remains.
export function revocationAnnouncement(language,{label,remaining=0}={}){const es=language==='es';const id=typeof label==='string'&&/^[a-f0-9]{8}$/.test(label)?label:null;
const head=es?(id?'Acceso revocado para el vínculo '+id+'. Ese vínculo ya no puede leer ni cambiar esta conversación.':'Acceso revocado.'):(id?'Access revoked for pairing '+id+'. That pairing can no longer read or change this conversation.':'Access revoked.');
const rest=es?(remaining>1?'Quedan '+remaining+' otros vínculos activos.':remaining===1?'Queda 1 otro vínculo activo.':'No queda ningún vínculo activo.'):(remaining>1?remaining+' other pairings remain active.':remaining===1?'1 other pairing remains active.':'No paired access remains.');
return head+' '+rest;}
// Each reply is numbered by its exchange (sequence/2) because VoiceOver did not repeat an identical live-region message.
// One pending announcement at a time: a newer message, Forget, re-pair or a conversation change cancels the delayed one
// and clears the region, so outdated text is never spoken. The short delay makes each message a distinct region update.
export function createAnnouncer(region,{schedule=fn=>setTimeout(fn,150),cancel=id=>clearTimeout(id)}={}){let pending=null;
function clear(){if(pending!==null){cancel(pending);pending=null;}region.textContent='';}
return {say(text){clear();if(!text)return false;pending=schedule(()=>{pending=null;region.textContent=text;});return true;},clear};}
export function conversationReplaced(prev,next){return !!prev&&!!next&&prev.conversationId!==next.conversationId;}
export function completionStatus(announced,generic){return announced?'':generic;}
