import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../../src/server/shopping.ts',import.meta.url),'utf8');
const block=source.slice(source.indexOf('const BUDGET_CUES'),source.indexOf('\nexport function mergeInterpretedNeeds'));
const {readBudgetFromText,settleShopperText}=new Function(stripTypeScriptTypes(block.replaceAll('export ',''))+';return {readBudgetFromText,settleShopperText};')();
test('reported English word and punctuated grouped budgets populate review',()=>{
 for(const text of ['My budget is one thousand dollars.','My budget is $1,000.','I need a laptop for Python programming. My budget is one thousand dollars.'])assert.deepEqual(readBudgetFromText(text),{candidate:'1000',ambiguous:false},text);
 const result=settleShopperText('My budget is one thousand dollars.',{understoodUse:'programming',budgetDollars:null,followUp:'budget'});
 assert.equal(result.prefilledBudgetDollars,'1000');assert.equal(result.notice,'review');
});
test('whole-dollar English grammar supports hundreds, thousands and hyphens',()=>{
 for(const [text,want] of [['budget six hundred dollars','600'],['budget one thousand five hundred dollars','1500'],['budget nine hundred and ninety-nine dollars','999'],['budget twenty-one thousand dollars','21000'],['budget ninety nine thousand nine hundred and ninety nine dollars','99999']])assert.deepEqual(readBudgetFromText(text),{candidate:want,ambiguous:false},text);
});
test('decimal, malformed, negative and conflicting amounts are never salvaged',()=>{
 for(const text of ['budget $1,000.50','budget $12,34.','budget $100,000.','16 GB','one thousand GB'])assert.equal(readBudgetFromText(text).candidate,null,text);
 for(const text of ['budget one thousand point five dollars','budget minus one thousand dollars','budget one thousand thousand dollars','budget one thousand and dollars','budget one hundred and and fifty dollars','budget 1 thousand dollars','budget one thousand or 900 dollars','budget one thousand or two thousand dollars'])assert.deepEqual(readBudgetFromText(text),{candidate:null,ambiguous:true},text);
});
test('existing Spanish and numeric budgets remain intact',()=>{
 for(const [text,want] of [['Presupuesto mil dólares','1000'],['Presupuesto novecientos noventa y nueve dólares','999'],['budget $1,000','1000'],['budget $500, please','500'],['8 GB and budget $1,000.','1000']])assert.deepEqual(readBudgetFromText(text),{candidate:want,ambiguous:false},text);
});
