import http from 'node:http';import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';import {readFile,open,unlink,stat} from 'node:fs/promises';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {makeAuthority} from './authority.mjs';import {makePersistence} from './persistence.mjs';import {makeConversationStore} from './conversation.mjs';import {exact} from './contract.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const failure=code=>({ok:false,code});
const status=code=>code==='STALE_REVISION'||code==='REQUEST_CONFLICT'?409:code==='TOKEN_INVALID'?401:code==='RATE_LIMIT'||code==='POLL_LIMIT'||code==='POLL_TOO_SOON'?429:(code==='PERSISTENCE_FAILED'||code==='PERSISTENCE_OUTCOME_UNKNOWN')?503:code==='SNAPSHOT_CAPACITY'?413:400;
export async function startServer({port=3764,dataDirectory,extensionOrigin}={}){
 if(!Number.isInteger(port)||port<0||port>65535||!dataDirectory||!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin??''))throw Error('INVALID_LOCAL_CONFIGURATION');
 const persistence=await makePersistence(dataDirectory),conversations=await makeConversationStore(persistence);
 const lockPath=join(dataDirectory,'server.lock');const lock=await open(lockPath,'wx',0o600);let cookieKey;
 try{const f=await open(join(dataDirectory,'cookie.key'),'wx',0o600);try{await f.writeFile(randomBytes(32));await f.sync();}finally{await f.close();}}catch(e){if(e.code!=='EEXIST'){await lock.close();await unlink(lockPath);throw e;}}
 try{if(((await stat(join(dataDirectory,'cookie.key'))).mode&0o777)!==0o600)throw Error('COOKIE_KEY_MODE');cookieKey=await readFile(join(dataDirectory,'cookie.key'));if(cookieKey.length!==32)throw Error('COOKIE_KEY_INVALID');}catch(e){await lock.close();await unlink(lockPath);throw e;}
 const a=makeAuthority();let origin,closed=false;const csrf=id=>createHmac('sha256',cookieKey).update('csrf:'+id).digest('hex');
 const mac=v=>createHmac('sha256',cookieKey).update('cookie:'+v).digest('hex');
 const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
 function session(req,res,create=false){
  const value=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('e1_session='))?.slice(11);let id,createdAt;
  if(value){const p=value.split('.');if(p.length===4&&/^[a-f0-9]{64}$/.test(p[0])&&/^\d{13}$/.test(p[1])&&/^\d{13}$/.test(p[2])&&eq(mac(p.slice(0,3).join('.')),p[3])&&Date.now()>=Number(p[2])&&Number(p[2])>=Number(p[1])&&Date.now()-Number(p[1])<86400000&&Date.now()-Number(p[2])<7200000){id=p[0];createdAt=Number(p[1]);if(!a.parent(id))a.createParent(id,{createdAt,lastSeenAt:Number(p[2])});if(!a.parent(id))id=null;}}
  if(!id&&create){id=randomBytes(32).toString('hex');createdAt=Date.now();a.createParent(id);}
  if(id){a.touchParent(id);const payload=id+'.'+createdAt+'.'+Date.now();const maxAge=Math.max(0,Math.floor((createdAt+86400000-Date.now())/1000));res.setHeader('Set-Cookie',`e1_session=${payload}.${mac(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);return id;}return null;
 }
 function json(res,result,httpStatus=result.ok?200:status(result.code)){res.writeHead(httpStatus,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));}
 async function body(req){if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))return failure('MEDIA_TYPE');if(Number(req.headers['content-length'])>16384){req.resume();return failure('BODY_TOO_LARGE');}return new Promise(resolve=>{let bytes=0,chunks=[],done=false;const finish=v=>{if(done)return;done=true;clearTimeout(timer);resolve(v);};const timer=setTimeout(()=>{finish(failure('BODY_TIMEOUT'));req.resume();},5000);req.on('data',c=>{if(done)return;bytes+=c.length;if(bytes>16384){chunks=[];finish(failure('BODY_TOO_LARGE'));}else chunks.push(c);});req.on('end',()=>{if(done)return;try{finish({ok:true,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{finish(failure('BAD_JSON'));}});req.on('error',()=>finish(failure('BAD_REQUEST')));req.on('aborted',()=>finish(failure('BAD_REQUEST')));});}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   if(req.headers.host!==new URL(origin).host)return json(res,failure('HOST_DENIED'),403);
   const path=new URL(req.url,origin).pathname,requestOrigin=req.headers.origin;
   const extPath=path.startsWith('/api/extension/v1/');
   if(extPath){if(requestOrigin!==extensionOrigin)return json(res,failure('ORIGIN_DENIED'),403);res.setHeader('Access-Control-Allow-Origin',extensionOrigin);res.setHeader('Vary','Origin');}
   else if(requestOrigin&&requestOrigin!==origin)return json(res,failure('ORIGIN_DENIED'),403);
   if(req.method==='OPTIONS'){if(!extPath)return json(res,failure('METHOD_DENIED'),405);res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH');res.setHeader('Access-Control-Allow-Headers','authorization, content-type');res.writeHead(204);return res.end();}
   const assets={'/':'index.html','/site.mjs':'site.mjs','/styles.css':'styles.css','/client.mjs':'client.mjs'};
   if(Object.hasOwn(assets,path)&&req.method==='GET'){const data=await readFile(join(root,path==='/client.mjs'?'extension':'web',assets[path]));res.writeHead(200,{'Content-Type':path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':'text/html; charset=utf-8'});return res.end(data);}
   if(path==='/api/mock/session'&&req.method==='GET'){const id=session(req,res,true);return json(res,{ok:true,value:{csrfToken:csrf(id),parentId:id}});}
   let parsed;
   if(['POST','PATCH'].includes(req.method)){parsed=await body(req);if(!parsed.ok)return json(res,parsed,parsed.code==='BODY_TOO_LARGE'?413:parsed.code==='MEDIA_TYPE'?415:parsed.code==='BODY_TIMEOUT'?408:400);}
   const input=parsed?.value;
   if(path==='/api/extension/v1/pairings'&&req.method==='POST'){if(!exact(input,['protocolVersion','challenge'])||input.protocolVersion!==1)return json(res,failure('BAD_REQUEST'));return json(res,a.pairingStart(input));}
   const match=path.match(/^\/api\/extension\/v1\/pairings\/([a-f0-9]{64})\/(status|exchange)$/);
   if(match&&req.method==='POST'){const fields=match[2]==='status'?['exchangeSecret']:['exchangeSecret','verifier'];if(!exact(input,fields))return json(res,failure('BAD_REQUEST'));return json(res,a[match[2]==='status'?'pairingStatus':'pairingExchange']({pairingId:match[1],...input}));}
   let parentId;
   if(extPath){const bearer=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];const scope=req.method==='GET'?'conversation:read':path.endsWith('/language')?'language:write':'conversation:write';const auth=a.resolve({bearer,scope});if(!auth.ok)return json(res,auth,auth.code==='SCOPE_DENIED'?403:401);parentId=auth.value.parentId;}
   else if(path.startsWith('/api/mock/')){parentId=session(req,res);if(!parentId)return json(res,failure('SESSION_INVALID'),401);if(req.method!=='GET'&&(requestOrigin!==origin||!eq(req.headers['x-csrf-token'],csrf(parentId))))return json(res,failure('CSRF_DENIED'),403);}
   else return json(res,failure('NOT_FOUND'),404);
   if(path==='/api/mock/approve'&&req.method==='POST'){if(!exact(input,['pairingId'])&&!exact(input,['pairingId','deny']))return json(res,failure('BAD_REQUEST'));return json(res,a.pairingApprove({...input,parentId}));}
   if(path==='/api/mock/revoke'&&req.method==='POST'){if(!exact(input,['childId']))return json(res,failure('BAD_REQUEST'));return json(res,a.revokeChild({...input,parentId}));}
   if(path==='/api/mock/children'&&req.method==='GET')return json(res,{ok:true,value:a.listChildren(parentId)});
   if((path==='/api/mock/conversation'||path==='/api/extension/v1/conversation')&&req.method==='GET')return json(res,{ok:true,value:conversations.read(parentId)});
   const kind=['/api/mock/conversation/turns','/api/extension/v1/conversation/turns'].includes(path)?'turn':['/api/mock/conversation/language','/api/extension/v1/conversation/language'].includes(path)?'language':null;
   if(kind&&((kind==='turn'&&req.method==='POST')||(kind==='language'&&req.method==='PATCH'))){const fields=['expectedRevision','clientRequestId',kind==='turn'?'text':'language'];if(!exact(input,fields))return json(res,failure('BAD_REQUEST'));const result=await conversations.command({parentId,expectedRevision:input.expectedRevision,clientRequestId:input.clientRequestId,kind,payload:kind==='turn'?{text:input.text}:{language:input.language}});return json(res,result);}
   return json(res,failure('METHOD_OR_PATH_DENIED'),405);
  }catch{return json(res,failure('INTERNAL_ERROR'),500);}
 });
 server.requestTimeout=6000;server.headersTimeout=6000;
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;resolve();});});}catch(e){await lock.close();await unlink(lockPath);throw e;}
 return {origin,dataDirectory,async close(){if(closed)return;closed=true;await new Promise(resolve=>server.close(resolve));await lock.close();await unlink(lockPath);}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==3){console.error('Usage: node server.mjs PORT PRIVATE_DATA_DIRECTORY chrome-extension://EXTENSION_ID');process.exitCode=1;}else{try{const s=await startServer({port:Number(args[0]),dataDirectory:args[1],extensionOrigin:args[2]});console.log('E1 synthetic mock only: '+s.origin);let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await s.close();});}catch{console.error('E1 startup refused; check private data directory, lock, origin and port.');process.exitCode=1;}}
}
