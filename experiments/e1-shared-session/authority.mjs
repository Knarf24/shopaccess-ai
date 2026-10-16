import { randomBytes as cryptoRandomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
const ok=value=>({ok:true,value}); const no=code=>({ok:false,code});
export function makeAuthority({now=Date.now,randomBytes=cryptoRandomBytes,digestKey=cryptoRandomBytes(32)}={}) {
  const parents=new Map(), pairings=new Map(), children=new Map(); let windowAt=now(), starts=0;
  const secret=()=>randomBytes(32).toString('hex');
  const digest=v=>createHmac('sha256',digestKey).update(v).digest('hex');
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
  const parent=id=>{const p=parents.get(id);return p&&!p.revoked&&now()<p.absoluteExpiresAt&&now()-p.lastSeenAt<7200000?{...p}:null;};
  function findPair(id){const p=pairings.get(id);return !p?no('PAIRING_UNKNOWN'):now()>=p.expiresAt?no('PAIRING_EXPIRED'):ok(p);}
  function resolve({bearer,scope}){if(typeof bearer!=='string'||!/^[a-f0-9]{64}$/.test(bearer))return no('TOKEN_INVALID');const c=children.get(digest(bearer));if(!c||c.revoked||now()>=c.expiresAt||!parent(c.parentId))return no('TOKEN_INVALID');return c.scopes.includes(scope)?ok({parentId:c.parentId,childId:c.childId}):no('SCOPE_DENIED');}
  const revokeChildren=id=>{for(const c of children.values())if(c.parentId===id)c.revoked=true;};
  return {
    parent,
    createParent(id, times={}){id??=secret();if(parents.has(id))return parent(id);const p={id,lastSeenAt:times.lastSeenAt??now(),absoluteExpiresAt:(times.createdAt??now())+86400000,revoked:false};parents.set(id,p);return {...p};},
    touchParent(id){const p=parents.get(id);if(parent(id))p.lastSeenAt=now();},
    pairingStart({challenge}){if(typeof challenge!=='string'||!/^[a-f0-9]{64}$/.test(challenge))return no('BAD_CHALLENGE');if(now()-windowAt>=60000){windowAt=now();starts=0;}if(starts>=30)return no('RATE_LIMIT');starts++;for(const [id,p]of pairings)if(now()>=p.expiresAt)pairings.delete(id);const pairingId=secret(),exchangeSecret=secret(),expiresAt=now()+300000;pairings.set(pairingId,{pairingId,challenge,exchangeDigest:digest(exchangeSecret),expiresAt,status:'pending',parentId:null,polls:0,lastPoll:-Infinity});return ok({pairingId,exchangeSecret,expiresAt});},
    pairingApprove({pairingId,parentId,deny=false}){if(!parent(parentId))return no('SESSION_INVALID');const f=findPair(pairingId);if(!f.ok)return f;const p=f.value;if(p.status!=='pending')return no('PAIRING_ALREADY_DECIDED');const active=[...pairings.values()].filter(x=>x.parentId===parentId&&x.status==='approved'&&now()<x.expiresAt).length;if(active>=3)return no('PAIRING_LIMIT');p.parentId=parentId;p.status=deny?'denied':'approved';return ok({status:p.status});},
    pairingStatus({pairingId,exchangeSecret}){const f=findPair(pairingId);if(!f.ok)return f;const p=f.value;if(typeof exchangeSecret!=='string'||!same(digest(exchangeSecret),p.exchangeDigest))return no('PAIRING_UNKNOWN');if(p.polls>=10)return no('POLL_LIMIT');if(now()-p.lastPoll<2000)return no('POLL_TOO_SOON');p.polls++;p.lastPoll=now();return ok({status:p.status});},
    pairingExchange({pairingId,exchangeSecret,verifier}){const f=findPair(pairingId);if(!f.ok)return f;const p=f.value;if(typeof exchangeSecret!=='string'||!same(digest(exchangeSecret),p.exchangeDigest))return no('PAIRING_UNKNOWN');if(p.status!=='approved')return no('PAIRING_NOT_APPROVED');if(typeof verifier!=='string'||!/^[a-f0-9]{64}$/.test(verifier)||!same(createHash('sha256').update(verifier).digest('hex'),p.challenge))return no('VERIFIER_INVALID');const owner=parent(p.parentId);if(!owner)return no('SESSION_INVALID');p.status='consumed';const bearer=secret(),childId=secret(),expiresAt=Math.min(now()+3600000,owner.absoluteExpiresAt);children.set(digest(bearer),{childId,parentId:p.parentId,expiresAt,revoked:false,scopes:['conversation:read','conversation:write','language:write']});return ok({bearer,childId,expiresAt});},
    resolve,
    listChildren(parentId){return [...children.values()].filter(x=>x.parentId===parentId&&!x.revoked&&now()<x.expiresAt).map(({childId,expiresAt})=>({childId,expiresAt}));},
    revokeChild({parentId,childId}){const c=[...children.values()].find(x=>x.childId===childId&&x.parentId===parentId);if(!c)return no('TOKEN_UNKNOWN');c.revoked=true;return ok({revoked:true});},
    revokeParent(id){const p=parents.get(id);if(p)p.revoked=true;revokeChildren(id);},
    rotateParent(id){revokeChildren(id);},
  };
}
