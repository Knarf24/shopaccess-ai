import test from 'node:test';
import assert from 'node:assert/strict';
import { workloadGuidance } from '../../src/lib/readiness/workload-guidance.ts';
test('the reported local AI question receives clarification instead of confirmation', () => {
 const reply = workloadGuidance('I will use it for Python programming and testing small AI models on the laptop itself. What specifications do I need, and which options fit my $1,000 budget?', 'en');
 assert.match(reply, /GPU and VRAM/);
 assert.match(reply, /cannot yet verify/);
 assert.match(reply, /Which AI model/);
 assert.doesNotMatch(reply, /confirm my choices/);
});
test('unclear AI workloads ask where models run, one question at a time', () => {
 const reply = workloadGuidance('I need a laptop for Python and AI models', 'en');
 assert.match(reply, /laptop itself or use a cloud service/);
 assert.equal((reply.match(/\?/g) ?? []).length, 1);
});
test('Spanish gets the same honest workload clarification', () => {
 assert.match(workloadGuidance('Quiero ejecutar modelos de IA localmente', 'es'), /GPU/);
 assert.match(workloadGuidance('Necesito un portátil para inteligencia artificial', 'es'), /nube/);
});
test('ordinary needs and navigation keep their existing replies', () => {
 for (const text of ['budget $600', 'confirm my choices', 'open permissions', 'return to my selection', 'schoolwork', 'I need a charger']) assert.equal(workloadGuidance(text, 'en'), null);
});
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
test('the actual transcript renderer uses the clarification only for a review reply', () => {
 const source=readFileSync(new URL('../../src/components/mock-journey/NeedsConversation.tsx',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('function isNeedsNotice'),source.indexOf('\nfunction ConversationHistory'));
 const assistantText=new Function('workloadGuidance',stripTypeScriptTypes(block.replace('export function','function'))+';return assistantText;')(workloadGuidance);
 const question='I need AI models on my laptop';
 assert.match(assistantText('review',{notices:{review:'Check your choices'}},'en',question),/GPU and VRAM/);
 assert.equal(assistantText('missing_budget',{notices:{missing_budget:'What is your budget?'}},'en',question),'What is your budget?');
});
