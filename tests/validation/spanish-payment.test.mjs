import test from 'node:test';
import assert from 'node:assert/strict';
import * as simulation from '../../src/server/simulation.ts';
test('Spanish payment preview renders localized controls and honest state explanations',()=>{
 const copy=simulation.paymentPreviewCopy?.('es');
 assert.equal(copy?.heading,'Vista previa de pago local');
 assert.equal(copy.steps.create_order,'Simular la creación del pedido');
 assert.match(copy.states.CAPTURED_VERIFIED,/No se movió dinero real/);
 assert.match(copy.states.CAPTURE_UNKNOWN,/No se sabe/);
 assert.match(copy.states.CAPTURE_PENDING_PROVIDER,/no es un pago completado/);
 assert.match(copy.disclosure,/no contacta con PayPal/);
 for(const step of simulation.SIMULATION_STEPS)assert.ok(copy.steps[step]);
 for(const state of Object.keys(simulation.STATE_DESCRIPTIONS))assert.ok(copy.states[state]);
});
test('English preview retains the existing state descriptions and step behavior',()=>{
 const copy=simulation.paymentPreviewCopy?.('en');
 assert.equal(copy?.heading,'Local payment preview');
 assert.equal(copy.steps,simulation.STEP_LABELS);
 assert.equal(copy.states,simulation.STATE_DESCRIPTIONS);
 assert.deepEqual(simulation.availableSteps('CAPTURED_VERIFIED'),['external_refund']);
 assert.deepEqual(simulation.availableSteps('CAPTURE_UNKNOWN'),['reconcile']);
});
