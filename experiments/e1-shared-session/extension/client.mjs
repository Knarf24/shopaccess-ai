export const ORIGIN='http://127.0.0.1:3764';
export async function settleSubmit(lock,action){if(lock.pending)return false;lock.pending=true;try{await action();return true;}finally{lock.pending=false;}}
export async function beginPairing({api,storage}){const verifier=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));const challenge=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');const b=await api('/api/extension/v1/pairings',{protocolVersion:1,challenge});const pairing={...b,verifier,polls:0};await storage.set({pairing});return pairing;}
export async function loadAccess(storage){return (await storage.get('access')).access??null;}

export async function recoverStale(action,refresh){try{return await action();}catch(e){if(e.message==='STALE_REVISION')await refresh();throw e;}}
export async function runPairingPoll({pairing,active,status,exchange,store,clear=async()=>{}}){const result=await status(pairing);if(!active())return 'cancelled';if(result.status!=='approved')return result.status;const access=await exchange(pairing);if(!active())return 'cancelled';await store(access);if(!active()){await clear(access);return 'cancelled';}return 'paired';}
