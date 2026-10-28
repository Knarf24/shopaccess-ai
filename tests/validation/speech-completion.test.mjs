import test from 'node:test';
import assert from 'node:assert/strict';
import {speakInSequence} from '../../src/lib/voice/speech-sequence.ts';
const reply='For local models, we need the model requirements and verified RAM, GPU and VRAM details. The cards show RAM and storage; those alone do not verify AI capability. I cannot yet verify which option will run your model, or assume an NVIDIA GPU from the product name. Which AI model do you want to run?';
function harness(t,text){
 t.mock.timers.enable({apis:['setTimeout']});
 const spoken=[],ends=[],failures=[],progress=[];let completed=0,failed=0,cancelled=0;
 const stop=speakInSequence({text,progress:p=>progress.push(p),speak:(part,end,error)=>{spoken.push(part);ends.push(end);failures.push(error);return()=>{cancelled++;};},done:()=>completed++,failed:()=>failed++});
 return {spoken,ends,failures,progress,stop,get completed(){return completed;},get failed(){return failed;},get cancelled(){return cancelled;}};
}
test('reported reply is bounded and final question finishes before completion',t=>{
 const h=harness(t,reply);
 assert.equal(h.spoken[0],'For local models, we need the model requirements and verified RAM, GPU and VRAM details.');
 for(let i=0;i<3;i++){assert.equal(h.completed,0);h.ends[i]();t.mock.timers.tick(500);}
 assert.equal(h.spoken[3],'Which AI model do you want to run?');assert.equal(h.completed,0);
 h.ends[3]();assert.equal(h.completed,1);h.ends[3]();assert.equal(h.completed,1);
 assert.deepEqual(h.progress,h.spoken);assert.equal(h.spoken.join(' '),reply);
});
test('paragraph pauses and decimal prices survive segmentation',t=>{
 const h=harness(t,'Option one costs $579.99. It has 8 GB RAM.\n\nOption two costs $879.99.');
 h.ends[0]();t.mock.timers.tick(180);assert.equal(h.spoken[1],'It has 8 GB RAM.');
 h.ends[1]();t.mock.timers.tick(499);assert.equal(h.spoken.length,2);t.mock.timers.tick(1);
 assert.equal(h.spoken[2],'Option two costs $879.99.');h.ends[2]();assert.equal(h.completed,1);
});
test('long unpunctuated text is bounded without dropping words',t=>{
 const text=('programming memory requirements ').repeat(30).trim();const h=harness(t,text);
 for(let i=0;i<100&&h.completed===0;i++){h.ends[i]();t.mock.timers.tick(500);}
 assert.equal(h.completed,1);assert.ok(h.spoken.every(s=>s.length<=240));assert.equal(h.spoken.join(' '),text);
});
test('stop during a pause prevents the final question and ignores late events',t=>{
 const h=harness(t,'First sentence. Final question?');h.ends[0]();h.stop();t.mock.timers.tick(1000);h.ends[0]();
 assert.deepEqual(h.spoken,['First sentence.']);assert.equal(h.completed,0);assert.equal(h.failed,0);
});
test('speech failure never signals successful completion',t=>{
 const h=harness(t,'First sentence. Final question?');h.failures[0]();h.ends[0]();t.mock.timers.tick(1000);
 assert.equal(h.failed,1);assert.equal(h.completed,0);assert.equal(h.spoken.length,1);
});
