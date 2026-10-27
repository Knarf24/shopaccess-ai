import test from 'node:test';
import assert from 'node:assert/strict';
import {selectVoiceOption,chargerVoiceAction,isPermissionsRequest} from '../../src/lib/voice/journey.ts';
const options=[{productId:'one',variantId:'v1',title:'Acer Aspire Go 15',priceCents:57999,description:'',recommended:false},{productId:'two',variantId:'v2',title:'Acer Aspire 14 AI',priceCents:87999,description:'',recommended:true}];
test('Spanish explicit product choices select the current item without AI',()=>{
 for(const text of ['Yo quiero la opción uno','Elijo la opción 1','  yo   elijo la opción uno.  ','Seleccionar la opción uno'])assert.equal(selectVoiceOption(text,options)?.productId,'one',text);
 assert.equal(selectVoiceOption('Quiero la opción dos',options)?.productId,'two');
});
test('uncertain, negated, unavailable and compound choices do not select',()=>{
 for(const text of ['el hijo la opción 1','No quiero la opción uno','Quiero la opción tres','Quiero la opción uno y comprar','Quiero la opción uno o dos'])assert.equal(selectVoiceOption(text,options),null,text);
});
test('task-choice speech produces only the explicit laptop or charger action',()=>{
 for(const text of ['portátil','Quiero un portátil','Busca el portátil'])assert.deepEqual(chargerVoiceAction(text,'task_choice'),{action:'choose_task',value:'laptop'},text);
 assert.deepEqual(chargerVoiceAction('Quiero un cargador','task_choice'),{action:'choose_task',value:'charger'});
 for(const text of ['no quiero un portátil','portátil o cargador','comprar portátil','confirmar pago'])assert.equal(chargerVoiceAction(text,'task_choice'),null,text);
 assert.equal(chargerVoiceAction('portátil','confirmed'),null);
});
test('Spanish permission navigation accepts the visible label without granting authority',()=>{
 assert.equal(isPermissionsRequest('Administrar permisos de compra'),true);
 assert.equal(isPermissionsRequest('abrir permisos'),true);
 assert.equal(isPermissionsRequest('crear permiso de compra'),false);
});
// Execute the actual production callback, with only DOM/transport boundaries replaced.
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const panel=readFileSync(new URL('../../src/components/mock-journey/HandsFreeControls.tsx',import.meta.url),'utf8');
const body=panel.split('onMessage: text => {')[1].split('\n      },\n    });')[0];
const callback=stripTypeScriptTypes('function handle(text:string) {'+body+'\n}');
function harness(stage,charger=null) {
 class Input {}
 class Form {querySelector(){return new Input();}}
 const form=new Form();
 const sent=[];const replies=[];const selection={current:null};
 const factory=new Function('pageRef','pending','language','session','selection','routerRef','window','document','HTMLFormElement','HTMLInputElement','FormData','formBody','send','chargerVoiceAction','selectVoiceOption','isNeedsConfirmation','isPermissionsRequest','voiceOptionsSummary',callback+';return handle;');
 const handle=factory({current:{stage,charger,options,reply:'Choose laptop or charger'}},{current:null},'es',{respond:x=>replies.push(x),waitForReply:()=>true,fail:()=>{throw Error('unexpected failure')}},selection,{current:{push:()=>{throw Error('unexpected navigation')}}},{location:{origin:'https://example.test'}},{querySelectorAll:()=>[form]},Form,Input,class {get(){return 'choose_task';}},()=>new URLSearchParams({csrfToken:'fixture',draftId:'draft',revision:'4',action:'choose_task'}),(data,field,path)=>sent.push({data,path}),chargerVoiceAction,selectVoiceOption,()=>false,isPermissionsRequest,()=> 'options');
 return {handle,sent,replies,selection};
}
test('task-choice callback submits task and current form fields to charger control, not AI',()=>{
 const h=harness('charger',{state:'task_choice'});h.handle('Quiero un portátil');
 assert.equal(h.sent.length,1);assert.equal(h.sent[0].path,'/shop/needs/charger-control');
 assert.equal(h.sent[0].data.get('task'),'laptop');assert.equal(h.sent[0].data.get('revision'),'4');
 assert.equal(h.sent[0].data.get('csrfToken'),'fixture');
});
test('ambiguous task answers stay at task choice without an AI submission',()=>{
 const h=harness('charger',{state:'task_choice'});h.handle('portátil o cargador');
 assert.equal(h.sent.length,0);assert.equal(h.replies.length,1);
});
test('Spanish option command selects locally without authorizing checkout',()=>{
 const h=harness('options');h.handle('Yo quiero la opción uno');
 assert.equal(h.selection.current?.productId,'one');assert.equal(h.sent.length,0);
 assert.match(h.replies[0],/No se ha autorizado el pago/);
});
