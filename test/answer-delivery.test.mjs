import test from 'node:test';
import assert from 'node:assert/strict';
import { VaryEngine } from '../src/varina/vary.mjs';
import { operators } from '../src/operators.mjs';
import { EXPLORATION_TOOLS } from '../src/varina/react.mjs';
import { validateJsonSchema } from '../src/agent/schemas.mjs';
import { MemoryHost } from '../src/host/node_fs_host.mjs';

// Finish closes exploration without producing a user-facing answer. The main
// Agent receives the structured board, fact ledger and unresolved dependencies.
test('Finish closes exploration and preserves the investigation handoff', async () => {
    const criticalClaim = 'The benefit of switching has not been measured.';
    const peripheralClaim = 'Provider capacity metadata is unavailable.';
    let finalCheckpoint;
    let pointId;
    const config = {
      models: [{ id: 'test', protocol: 'chat' }],
      roles: { main: 'test', exploration: 'test' },
      seats: [{ id: 'Z1', modelId: 'test' }],
      exploration: { rounds: 1, maxReactSteps: 5 }
    };
    const gateway = { async invoke(request) {
      if (request.phase === 'varina_seat') return {
        seat_id: request.context.seat_id,
        packet_token: request.context.packet_token,
        analysis_summary: 'Prefer continuity unless switching has a concrete benefit.',
        contributions: [{
          local_id: 'C1', type: 'mechanism',
          text: 'Compare models at task boundaries instead of every message.',
          failure_condition: 'The boundary or benefit may not be observable.'
        }],
        verification_requests: [criticalClaim, peripheralClaim].map((claim, index) => ({
          claim_id: `V${index + 1}`, claim,
          why_it_matters: 'May affect the proposed switching policy.',
          search_hints: [], affected_local_ids: ['C1']
        }))
      };
      assert.equal(request.phase, 'varina_react');
      const call = (name, args) => ({ message: '', tool_calls: [{
        id: `call-${request.context.iteration}`, name, arguments_json: JSON.stringify(args)
      }] });
      if (request.context.round === 0) return call('Diverge', {});
      if (request.context.iteration === 2) {
        const result = request.messages.filter(message => message.role === 'tool')
          .map(message => JSON.parse(message.content)).find(item => item.name === 'Diverge');
        pointId = result.result.added_items[0].id;
        return call('UpdateBoardItem', {
          item_id: pointId, expected_revision: 1, action: 'update',
          reason: 'Keep the recommendation conditional on measured benefit.',
          patch: {
            text: 'Compare at task boundaries only when there is evidence of a benefit.',
            fact: {
              claim: criticalClaim, status: 'unknown',
              explanation: 'No measurements are available.', evidence: [],
              claim_ref: 'R1:Z1:V1'
            }
          }
        });
      }
      const toolResults = request.messages.filter(message => message.role === 'tool')
        .map(message => JSON.parse(message.content));
      const divergence = toolResults.find(item => item.name === 'Diverge').result;
      assert.deepEqual(divergence.verification_requests.map(item => item.claim), [criticalClaim, peripheralClaim]);
      const updatedFact = toolResults.find(item => item.name === 'UpdateBoardItem').result.fact;
      assert.equal(updatedFact.claim, criticalClaim);
      assert.equal(updatedFact.status, 'unknown');
      const lastMessage = request.messages.at(-1);
      if (lastMessage.role === 'user' && lastMessage.content.includes('必须调用无参数的 Finish()')) {
        return call('Finish', {});
      }
      return { message: 'This text must not become the user-facing answer.', tool_calls: [] };
    } };
    const engine = new VaryEngine({
      operatorPool: operators,
      host: new MemoryHost(), gateway, config,
      checkpoint: async runtime => { finalCheckpoint = structuredClone(runtime); }
    });
    const result = await engine.run({ sessionId: 'test-session', problem: 'When should I switch models?', seed: 1 });

    assert.equal(result.state, 'complete');
    assert.equal(result.rounds_executed, 1);
    assert.equal(Object.hasOwn(result, 'final_text'), false);
    assert.equal(Object.hasOwn(result.react, 'final_answer'), false);
    assert.equal(result.react.interventions.some(item => item.reason === 'FINISH_REQUIRED'), true);
    assert.equal(result.fact_ledger[0].status, 'unknown');
    assert.equal(result.fact_ledger[0].claim, criticalClaim);
    assert.equal(result.verification_requests.length, 2);
    assert.deepEqual(new Set(result.unresolved_questions), new Set([criticalClaim, peripheralClaim]));
    assert.equal(result.unresolved_questions.length, 2);
    assert.deepEqual(finalCheckpoint.handoff.unresolved_questions, result.unresolved_questions);
    assert.equal(Object.hasOwn(finalCheckpoint.handoff, 'final_text'), false);
    assert.deepEqual(result.solutions, []);
  });

test('Finish only accepts an empty payload', () => {
  const finish = EXPLORATION_TOOLS.find(tool => tool.function.name === 'Finish');
  assert.deepEqual(finish.function.parameters.required, []);
  validateJsonSchema({}, finish.function.parameters);
  assert.throws(
    () => validateJsonSchema({ answer: 'user-facing answer' }, finish.function.parameters),
    /\$\.answer 未定义/
  );
});
