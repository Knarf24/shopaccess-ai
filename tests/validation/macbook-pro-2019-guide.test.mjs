import {test} from 'node:test';
import assert from 'node:assert/strict';
test('matches only a definite 16-inch 2019 description and keeps purchase authority absent',async()=>{
 const {macBookPro2019Guide}=await import('../../src/lib/compatibility/macbook-pro-2019-guide.ts');
 for(const text of ['I need a charger for my MacBook Pro, 16-inch, 2019.','My laptop is a MacBook Pro, 16-inch, 2019.','MacBook Pro 16 inch 2019','MacBookPro16,1','MacBookPro16,4']){
  const guide=macBookPro2019Guide(text,'en');assert.ok(guide,text);assert.match(guide.summary,/96W/);assert.match(guide.summary,/USB-C/);assert.match(guide.summary,/79/);assert.match(guide.summary,/separately/);assert.equal(guide.referenceCents,7900);assert.equal(guide.checkoutAvailable,false);
 }
 for(const text of ['MacBook Pro 2019','MacBook Pro 16-inch 2021','not MacBook Pro 16-inch 2019','MacBook Pro 16-inch 2019 or 2021','MacBook Air M2 2022','maybe MacBook Pro 16-inch 2019','19 virgin'])assert.equal(macBookPro2019Guide(text,'en'),null,text);
 assert.match(macBookPro2019Guide('Mi portátil es un MacBook Pro 16 pulgadas 2019','es').summary,/96W/);
});
