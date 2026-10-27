import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../../src/components/mock-journey/HandsFreeControls.tsx',import.meta.url),'utf8');
// Exercise the real handler's normalization and return condition without React/browser dependencies.
const normalization=source.match(/const command=([^;]+);/)[1];
const matcher=source.match(/if\((\/\^\(\?:return to my selection[^\n]+?)\) \{navigate/)[1];
const recognizes=new Function('text',`const command=${normalization};return ${matcher};`);
test('permissions return instruction accepts transcription whitespace',()=>{
 for(const text of ['return to my selection','Return to my selection. ','return  to my selection','volver a mi selección. ']) assert.equal(recognizes(text),true,text);
});
test('return matching refuses negation and compound purchase commands',()=>{
 for(const text of ['do not return to my selection','return to my selection and buy it','save permission','']) assert.equal(recognizes(text),false,text);
});
