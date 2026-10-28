import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const panel=readFileSync(new URL('../../src/components/mock-journey/HandsFreeControls.tsx',import.meta.url),'utf8');
const body=panel.split('onMessage: text => {')[1].split('\n      },\n    });')[0];
const callback=stripTypeScriptTypes('function handle(text:string) {'+body+'\n}');
function harness(language='en',pendingValue=null){
 class Field {value='';} class Form {querySelector(){return new Field();}}
 const replies=[],sent=[],selection={current:null};
 const form=new Form();
 const factory=new Function('pageRef','pending','language','session','selection','routerRef','window','document','HTMLFormElement','HTMLInputElement','HTMLTextAreaElement','FormData','formBody','send','chargerVoiceAction','selectVoiceOption','isNeedsConfirmation','isPermissionsRequest','voiceOptionsSummary',callback+';return handle;');
 const handle=factory({current:{stage:'options',charger:null,options:[],reply:'options'}},{current:pendingValue},language,{respond:x=>replies.push(x),waitForReply:()=>true,fail:()=>replies.push('failed')},selection,{current:{push:()=>{throw Error('unexpected navigation')}}},{location:{origin:'https://example.test'}},{querySelector:()=>form},Form,Field,Field,class { *[Symbol.iterator](){yield ['csrfToken','fixture'];yield ['draftId','saved-draft'];yield ['version','7'];}},()=>new URLSearchParams(),(data,field,path)=>sent.push({data,path}),()=>null,(text)=>/^(?:choose option one|yo quiero la opción uno)$/i.test(text)?{title:'fixture laptop',priceCents:50000}:null,()=>false,()=>false,()=> 'options');
 return {handle,replies,sent,selection};
}
test('I want workload speech reaches the protected conversation form on results',()=>{
 const h=harness();const text='I want to test small AI models on the laptop itself';h.handle(text);
 assert.equal(h.replies.length,0);assert.equal(h.sent.length,1);assert.equal(h.sent[0].path,'/shop/needs/submit');
 assert.equal(h.sent[0].data.get('shopperText'),text);assert.equal(h.sent[0].data.get('csrfToken'),'fixture');assert.equal(h.sent[0].data.get('draftId'),'saved-draft');assert.equal(h.selection.current,null);
});
test('Spanish workload speech is also conversational',()=>{
 const h=harness('es');h.handle('Yo quiero ejecutar modelos de IA localmente');assert.equal(h.sent.length,1);assert.equal(h.replies.length,0);
});
test('explicit valid option commands still select locally',()=>{
 for(const [language,text] of [['en','choose option one'],['es','Yo quiero la opción uno']]){const h=harness(language);h.handle(text);assert.equal(h.selection.current?.title,'fixture laptop');assert.equal(h.sent.length,0);assert.equal(h.replies.length,1);}
});
test('unavailable explicit option remains a clarification, never a conversation submission',()=>{
 for(const [language,text] of [['en','I want option ninety nine'],['es','Quiero la opción noventa y nueve']]){const h=harness(language);h.handle(text);assert.equal(h.selection.current,null);assert.equal(h.sent.length,0);assert.equal(h.replies.length,1);}
});
test('pending form work cannot submit a second workload request',()=>{
 const h=harness('en',{});h.handle('I want to test small AI models');assert.equal(h.sent.length,0);assert.equal(h.selection.current,null);
});
