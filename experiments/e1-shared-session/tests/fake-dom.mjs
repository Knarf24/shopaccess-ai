// Minimal DOM and browser stand-ins so the real panel.mjs and site.mjs modules run under node:test.
// Only what those two scripts touch is modelled. Not a general DOM.
import {register} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';

const base=new URL('..',import.meta.url);
const clientUrl=new URL('extension/client.mjs',base).href;
// site.mjs imports '/client.mjs' (served path); map it to the real file.
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='/client.mjs')return {url:${JSON.stringify(clientUrl)},shortCircuit:true};return n(s,c);}`));

export const wait=ms=>new Promise(r=>setTimeout(r,ms));

export function installDom(){
  const els=new Map();
  const doc={body:{tag:'body'},documentElement:{lang:'en'},activeElement:null};
  const make=(tag,id)=>{const el={tag,id,textContent:'',value:'',hidden:false,disabled:false,isConnected:true,children:[],onclick:null,onsubmit:null,onchange:null,
    focus(){doc.activeElement=el;},replaceChildren(...c){el.children=c;},append(...c){el.children.push(...c);}};return el;};
  doc.activeElement=doc.body;
  doc.getElementById=id=>{if(!els.has(id))els.set(id,make('el',id));return els.get(id);};
  doc.createElement=tag=>make(tag);
  doc.querySelectorAll=sel=>sel==='button,select'?[...els.values()]:[];
  doc.querySelector=sel=>sel==='#children button'?(els.get('children')?.children[0]?.children[0]??null):null;
  globalThis.document=doc;
  globalThis.window={addEventListener(){}};
  return {doc,els,el:id=>doc.getElementById(id)};
}

// fetch stub: routes[path] is a function (body, method) -> value, or throws a code string.
export function installFetch(routes){
  const calls=[];
  globalThis.fetch=async(url,opts={})=>{const path=new URL(url,'http://127.0.0.1:3764').pathname;const body=opts.body?JSON.parse(opts.body):undefined;calls.push({path,method:opts.method??'GET',body});
    const route=routes[path];if(!route)return {status:404,json:async()=>({ok:false,code:'NOT_FOUND'})};
    try{const value=await route(body,opts.method??'GET');return {status:200,json:async()=>({ok:true,value})};}catch(code){return {status:code==='TOKEN_INVALID'?401:409,json:async()=>({ok:false,code:String(code)})};}};
  return calls;
}

export function installChrome(initial={}){
  const store={...initial};
  globalThis.chrome={runtime:{id:'a'.repeat(32)},tabs:{create:async()=>({})},storage:{session:{
    async get(k){return typeof k==='string'?{[k]:store[k]}:{...store};},
    async set(v){Object.assign(store,v);},
    async remove(k){for(const key of [].concat(k))delete store[key];}}}};
  return store;
}

let n=0;
export const freshImport=rel=>import(new URL(rel,base).href+'?case='+(++n));
export const conversation=(conversationId,turns,language='en')=>({conversationId,revision:turns.length,interfaceLanguage:language,turns,historyTruncated:false});
export const turn=(sequence,role,text=role+' '+sequence)=>({id:'t'+sequence,role,text,sequence});
export {fileURLToPath,pathToFileURL};
