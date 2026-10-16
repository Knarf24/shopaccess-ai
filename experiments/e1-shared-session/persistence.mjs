import {mkdir,open,readFile,rename,unlink,stat} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {validateSnapshot} from './contract.mjs';
export async function makePersistence(directory,{syncDirectory}={}){
 await mkdir(directory,{recursive:true,mode:0o700});if(((await stat(directory)).mode&0o077)!==0)throw Error('DIRECTORY_NOT_PRIVATE');const path=join(directory,'state.json');
 return {
  async load(){try{const data=await readFile(path,'utf8');if(Buffer.byteLength(data)>8*1024*1024)throw Error('SNAPSHOT_TOO_LARGE');return validateSnapshot(JSON.parse(data));}catch(e){if(e.code==='ENOENT')return {format:1,sessions:{}};throw Error('SNAPSHOT_LOAD_FAILED');}},
  async save(data){validateSnapshot(data);const serialized=JSON.stringify(data);if(Buffer.byteLength(serialized)>8*1024*1024){const e=Error('SNAPSHOT_CAPACITY');e.code='SNAPSHOT_CAPACITY';throw e;}const tmp=join(directory,'.state-'+randomUUID());let file,published=false;try{file=await open(tmp,'wx',0o600);await file.writeFile(serialized);await file.sync();await file.close();file=null;await rename(tmp,path);published=true;const dir=await open(directory,'r');try{if(syncDirectory)await syncDirectory(dir);else await dir.sync();}finally{await dir.close();}}catch(e){if(published){const unknown=Error('PERSISTENCE_OUTCOME_UNKNOWN');unknown.code='PERSISTENCE_OUTCOME_UNKNOWN';throw unknown;}throw e;}finally{if(file)await file.close();await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
 };
}
