import {randomUUID} from 'node:crypto';
import {ok,no,exact,validateSnapshot} from './contract.mjs';
export async function makeConversationStore({load=async()=>({format:1,sessions:{}}),save=async()=>{}}={}) {
  let snapshot=validateSnapshot(await load()); let uncertain=false; let tail=Promise.resolve();const receipts=new Map();
  const fresh=()=>({protocolVersion:1,conversationId:randomUUID(),revision:0,requirementsRevision:0,interfaceLanguage:'en',turns:[],requirements:{use:null,budgetDollars:null},confirmedRequirementsRevision:null,selection:null,historyTruncated:false});
  const empty=new Map();
  const read=parentId=>structuredClone((Object.hasOwn(snapshot.sessions,parentId)?snapshot.sessions[parentId]:null)??(empty.has(parentId)?empty.get(parentId):(empty.set(parentId,fresh()),empty.get(parentId))));
  async function apply(input){
    if(uncertain)return no('PERSISTENCE_OUTCOME_UNKNOWN');
    if(!exact(input,['parentId','expectedRevision','clientRequestId','kind','payload'])||typeof input.parentId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(input.parentId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.clientRequestId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(input.clientRequestId)||!['turn','language'].includes(input.kind))return no('BAD_REQUEST');
    const {parentId,expectedRevision,clientRequestId,kind,payload}=input;
    if(kind==='turn'?(!exact(payload,['text'])||typeof payload.text!=='string'||payload.text.trim().length===0||payload.text.length>2000):(!exact(payload,['language'])||!['en','es'].includes(payload.language)))return no('BAD_REQUEST');
    const key=parentId+':'+clientRequestId, fingerprint=JSON.stringify(input), prior=receipts.get(key);
    if(prior)return prior.fingerprint===fingerprint?structuredClone(prior.result):no('REQUEST_CONFLICT');
    const current=read(parentId);if(expectedRevision!==current.revision)return no('STALE_REVISION',{revision:current.revision});
    if(!Object.hasOwn(snapshot.sessions,parentId)&&Object.keys(snapshot.sessions).length>=500)return no('CAPACITY');
    const next=structuredClone(current);next.revision++;
    if(kind==='language')next.interfaceLanguage=payload.language;
    else {
      const text=payload.text.trim();const use=/\bprogramming\b/i.test(text)?'programming':/\bschoolwork\b/i.test(text)?'schoolwork':/\bgeneral productivity\b/i.test(text)?'general_productivity':null;
      const amounts=[...text.matchAll(/\bbudget\s+(\d{1,5})\b/gi)]; const amount=amounts.length===1&&Number(amounts[0][1])>=10&&Number(amounts[0][1])<=99999?String(Number(amounts[0][1])):null;
      const requirements={use:use??next.requirements.use,budgetDollars:amount??next.requirements.budgetDollars};
      if(JSON.stringify(requirements)!==JSON.stringify(next.requirements)){next.requirementsRevision++;next.requirements=requirements;next.confirmedRequirementsRevision=null;next.selection=null;}
      const start=next.turns.at(-1)?.sequence??0;
      const reply=next.interfaceLanguage==='es'?'Asistente simulado local: mensaje guardado. Sin IA en vivo ni compras.':'Local mock assistant: message saved. No live AI or purchases.';
      next.turns.push({id:randomUUID(),role:'shopper',text,sequence:start+1},{id:randomUUID(),role:'assistant',text:reply,sequence:start+2});
      next.historyTruncated ||= next.turns.length>8;next.turns=next.turns.slice(-8);
    }
    const pending=structuredClone(snapshot);Object.defineProperty(pending.sessions,parentId,{value:next,writable:true,enumerable:true,configurable:true});
    try{await save(pending);}catch(e){if(e.code==='PERSISTENCE_OUTCOME_UNKNOWN'){uncertain=true;return no('PERSISTENCE_OUTCOME_UNKNOWN');}return no(e.code==='SNAPSHOT_CAPACITY'?'SNAPSHOT_CAPACITY':'PERSISTENCE_FAILED');}
    snapshot=pending;const result=ok(read(parentId));receipts.set(key,{fingerprint,result});if(receipts.size>2000)receipts.delete(receipts.keys().next().value);return structuredClone(result);
  }
  return {read,command(input){const p=tail.then(()=>apply(input));tail=p.catch(()=>{});return p;}};
}
