import test from 'node:test';
import assert from 'node:assert/strict';
import { ExploreDesignEngine } from '../src/varina/explore_design.mjs';
import { MemoryHost } from '../src/host/node_fs_host.mjs';

// Exercise both final-answer routes with real divergence, a pending verification
// request and an unknown fact. The full backlog must survive without becoming
// an automatically appended second answer.
for (const delivery of ['Finish', 'direct']) {
  test(`${delivery} preserves the chosen answer and keeps the investigation backlog in the handoff`, async () => {
    const criticalClaim = 'The benefit of switching has not been measured.';
    const peripheralClaim = 'Provider capacity metadata is unavailable.';
    const modelQuestion = 'Which task boundary should the caller use?';
    const answer = 'Keep the current model while it is making progress. Switch at a clear task boundary when the other model has a concrete advantage. That advantage has not yet been measured here, so treat this as a starting policy to validate.';
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
      // The model sees the pending claims and their latest fact update before
      // writing either final answer, even though the handoff union is built later.
      const toolResults = request.messages.filter(message => message.role === 'tool')
        .map(message => JSON.parse(message.content));
      const divergence = toolResults.find(item => item.name === 'Diverge').result;
      assert.deepEqual(divergence.verification_requests.map(item => item.claim), [criticalClaim, peripheralClaim]);
      const updatedFact = toolResults.find(item => item.name === 'UpdateBoardItem').result.fact;
      assert.equal(updatedFact.claim, criticalClaim);
      assert.equal(updatedFact.status, 'unknown');
      if (delivery === 'direct') return { message: answer, tool_calls: [] };
      return call('Finish', {
        answer,
        solutions: [{
          solution_id: 'S1', name: 'Keep continuity across a task',
          core_mechanism_ids: [pointId], defensive_patch_ids: [],
          inherent_costs: ['Can miss small gains from switching earlier.']
        }],
        // Include a duplicate to check that the audit union remains deduplicated.
        unresolved_questions: [criticalClaim, modelQuestion]
      });
    } };
    const engine = new ExploreDesignEngine({
      host: new MemoryHost(), gateway, config,
      checkpoint: async runtime => { finalCheckpoint = structuredClone(runtime); }
    });
    const result = await engine.run({ sessionId: 'test-session', problem: 'When should I switch models?', seed: 1 });

    assert.equal(result.state, 'complete');
    assert.equal(result.rounds_executed, 1);
    assert.equal(result.final_text, answer);
    assert.equal(result.react.final_answer, answer);
    assert.equal(result.fact_ledger[0].status, 'unknown');
    assert.equal(result.fact_ledger[0].claim, criticalClaim);
    assert.equal(result.verification_requests.length, 2);
    assert.deepEqual(new Set(result.unresolved_questions), new Set([
      criticalClaim, peripheralClaim, ...(delivery === 'Finish' ? [modelQuestion] : [])
    ]));
    assert.equal(result.unresolved_questions.length, delivery === 'Finish' ? 3 : 2);
    assert.deepEqual(finalCheckpoint.handoff.unresolved_questions, result.unresolved_questions);
    assert.equal(finalCheckpoint.handoff.final_text, answer);
    if (delivery === 'Finish') assert.equal(result.solutions[0].core_mechanism_ids[0], pointId);
  });
}
