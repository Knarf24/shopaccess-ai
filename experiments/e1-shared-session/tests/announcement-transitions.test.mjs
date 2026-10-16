import {test} from 'node:test';import assert from 'node:assert/strict';
import {installDom,installFetch,installChrome,freshImport,conversation,turn,wait} from './fake-dom.mjs';
// Review findings, October 16: (1) revocation wording did not identify which pairing was revoked when several were active;
// (2) a delayed announcement could still fire after Forget, re-pair or conversation replacement.
const ANNOUNCE_DELAY=150, AFTER=ANNOUNCE_DELAY+120;
const replyState=(id,extra=[])=>conversation(id,[turn(1,'shopper'),turn(2,'assistant','first'),...extra]);

async function panelWith(routes){const dom=installDom();installChrome({access:{bearer:'b'.repeat(64)}});const calls=installFetch(routes);await freshImport('extension/panel.mjs');await wait(20);return {...dom,calls};}

test('panel: Forget cancels a pending reply announcement and clears the region',async()=>{let current=replyState('c1');const p=await panelWith({'/api/extension/v1/conversation':()=>current});
current=replyState('c1',[turn(3,'shopper'),turn(4,'assistant','late reply')]);await p.el('refresh').onclick();
assert.equal(p.el('announce').textContent,'','announcement is still pending (delayed)');
await p.el('disconnect').onclick();await wait(AFTER);
assert.equal(p.el('announce').textContent,'','a cancelled announcement must not appear after Forget');});

test('panel: Pair (re-pair) cancels a pending reply announcement and clears the region',async()=>{let current=replyState('c1');const p=await panelWith({'/api/extension/v1/conversation':()=>current,'/api/extension/v1/pairings':()=>({pairingId:'d'.repeat(64),exchangeSecret:'e'.repeat(64),expiresAt:Date.now()+300000})});
current=replyState('c1',[turn(3,'shopper'),turn(4,'assistant','late reply')]);await p.el('refresh').onclick();
await p.el('pair').onclick();await wait(AFTER);
assert.equal(p.el('announce').textContent,'');
await p.el('disconnect').onclick();});

test('panel: conversation replacement cancels a pending announcement from the old conversation',async()=>{let current=replyState('c1');const p=await panelWith({'/api/extension/v1/conversation':()=>current});
current=replyState('c1',[turn(3,'shopper'),turn(4,'assistant','old conversation reply')]);await p.el('refresh').onclick();
current=replyState('c2',[turn(3,'shopper'),turn(4,'assistant','other conversation')]);await p.el('refresh').onclick();await wait(AFTER);
assert.equal(p.el('announce').textContent,'','neither the stale reply nor the replacement conversation is announced');});

test('panel: a newer reply supersedes a pending one; only the newest is spoken',async()=>{let current=replyState('c1');const p=await panelWith({'/api/extension/v1/conversation':()=>current});
current=replyState('c1',[turn(3,'shopper'),turn(4,'assistant','second')]);await p.el('refresh').onclick();
current=replyState('c1',[turn(3,'shopper'),turn(4,'assistant','second'),turn(5,'shopper'),turn(6,'assistant','third')]);await p.el('refresh').onclick();
const seen=[];for(let i=0;i<10;i++){await wait(30);seen.push(p.el('announce').textContent);}
assert.equal(seen.filter(t=>t.includes('second')).length,0,'the superseded announcement never appears');assert.equal(p.el('announce').textContent,'Assistant reply 3: third');});

async function siteWith(grants,language='en'){const dom=installDom();globalThis.location={href:'http://127.0.0.1:3764/'};let list=grants.map(childId=>({childId,expiresAt:Date.now()+3600000}));const revoked=[];
installFetch({'/api/mock/session':()=>({csrfToken:'c'.repeat(64),parentId:'p'.repeat(64)}),'/api/mock/conversation':()=>replyState('c1').interfaceLanguage===language?replyState('c1'):{...replyState('c1'),interfaceLanguage:language},'/api/mock/children':()=>list,'/api/mock/revoke':body=>{revoked.push(body.childId);list=list.filter(c=>c.childId!==body.childId);return {revoked:true};}});
await freshImport('web/site.mjs');await wait(20);return {...dom,revoked,buttons:()=>dom.el('children').children.map(li=>li.children[0])};}

test('website: with several active grants, the announcement names the revoked pairing and the remaining count (English)',async()=>{const a='11111111'+'a'.repeat(56),b='22222222'+'b'.repeat(56),c='33333333'+'c'.repeat(56);const s=await siteWith([a,b,c]);
assert.equal(s.buttons().length,3);await s.buttons()[1].onclick();await wait(AFTER);
assert.deepEqual(s.revoked,[b]);const said=s.el('announce').textContent;
assert.match(said,/^Access revoked for pairing 22222222\./);assert.match(said,/2 other pairings remain active\./);assert.equal(said.includes('11111111')||said.includes('33333333'),false);});

test('website: revoking the last remaining grant says none remain (Spanish)',async()=>{const a='44444444'+'a'.repeat(56);const s=await siteWith([a],'es');await s.buttons()[0].onclick();await wait(AFTER);
assert.match(s.el('announce').textContent,/^Acceso revocado para el vínculo 44444444\./);assert.match(s.el('announce').textContent,/No queda ningún vínculo activo\./);});

test('website: a second revocation before the first announcement fires replaces it',async()=>{const a='55555555'+'a'.repeat(56),b='66666666'+'b'.repeat(56);const s=await siteWith([a,b]);
const first=s.buttons()[0],second=s.buttons()[1];await first.onclick();await second.onclick();
const seen=[];for(let i=0;i<10;i++){await wait(30);seen.push(s.el('announce').textContent);}
assert.equal(seen.filter(t=>t.includes('55555555')).length,0,'the superseded revocation message never appears');assert.match(s.el('announce').textContent,/^Access revoked for pairing 66666666\. .*No paired access remains\./);});
