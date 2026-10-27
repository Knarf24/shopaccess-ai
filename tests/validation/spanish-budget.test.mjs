import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../../src/server/shopping.ts',import.meta.url),'utf8');
const block=source.slice(source.indexOf('const BUDGET_CUES'),source.indexOf('\nexport function mergeInterpretedNeeds'));
const {readBudgetFromText,settleShopperText}=new Function(stripTypeScriptTypes(block.replaceAll('export ',''))+';return {readBudgetFromText,settleShopperText};')();
test('Spanish whole-dollar words populate the review budget',()=>{
 for(const [text,want] of [
 ['Necesito un portátil para programar. Mi presupuesto es mil dólares.','1000'],
 ['Mi presupuesto es dos mil dólares','2000'],
 ['Presupuesto mil quinientos dólares','1500'],
 ['Presupuesto novecientos noventa y nueve dólares','999'],
 ['Presupuesto veintidós dólares','22'],
 ['Presupuesto cien dólares','100'],
 ['Presupuesto ciento veinte dólares','120'],
 ['Presupuesto noventa y nueve mil novecientos noventa y nueve dólares','99999'],
 ])assert.deepEqual(readBudgetFromText(text),{candidate:want,ambiguous:false},text);
 const result=settleShopperText('Necesito un portátil para programar. Mi presupuesto es mil dólares.',{understoodUse:'programming',budgetDollars:null,followUp:'budget'});
 assert.equal(result.prefilledBudgetDollars,'1000');assert.equal(result.notice,'review');
});
test('word and numeric conflicts still require clarification',()=>{
 assert.deepEqual(readBudgetFromText('Presupuesto mil dólares o 900 dólares'),{candidate:null,ambiguous:true});
 assert.deepEqual(readBudgetFromText('Presupuesto mil o dos mil dólares'),{candidate:null,ambiguous:true});
});
test('specifications, malformed amounts and decimals do not become word budgets',()=>{
 for(const text of ['mil GB','dieciséis GB de RAM','Presupuesto mil coma cinco dólares','Presupuesto dos mil mil dólares','Presupuesto cuatro dólares','Presupuesto cien mil dólares','Presupuesto menos mil dólares'])assert.equal(readBudgetFromText(text).candidate,null,text);
 assert.deepEqual(readBudgetFromText('dieciséis GB y presupuesto mil dólares'),{candidate:'1000',ambiguous:false});
 assert.deepEqual(readBudgetFromText('budget $1,000'),{candidate:'1000',ambiguous:false});
});
test('existing grouped, decimal and size cases remain unchanged',()=>{
 for(const [text,want] of [['$1,000','1000'],['budget $500, please','500'],['$1,000, please','1000'],['budget 10,000','10000'],['8 GB and a budget of 500','500']])assert.deepEqual(readBudgetFromText(text),{candidate:want,ambiguous:false});
 for(const text of ['budget $12,34','budget $1,000.50','budget $100,000','1,024 GB','8 GB','500 GB'])assert.deepEqual(readBudgetFromText(text),{candidate:null,ambiguous:false});
 assert.deepEqual(readBudgetFromText('under 500 or 600'),{candidate:null,ambiguous:true});
});
