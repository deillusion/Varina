import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, createSessionState } from '../src/agent/agent_session.mjs';
import { MemoryHost } from '../src/host/node_fs_host.mjs';
import { buildPayload } from '../src/provider.mjs';

test('synthetic Varina exchange uses native tool history for chat and Gemini payloads', () => {
  const messages = [
    {
      role: 'assistant',
      content: 'baseline answer',
      tool_calls: [{
        id: 'call-varina-test',
        type: 'function',
        function: { name: 'Vary', arguments: JSON.stringify({ problem: 'test' }) }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call-varina-test',
      content: JSON.stringify({ ok: true, result: { state: 'complete' } })
    }
  ];
  const chat = buildPayload({ model: 'chat-model', protocol: 'chat' }, { messages, generation: {} });
  assert.equal(chat.messages[0].tool_calls[0].function.name, 'Vary');
  assert.equal(chat.messages[1].tool_call_id, 'call-varina-test');

  const gemini = buildPayload({ model: 'gemini-model', protocol: 'gemini' }, { messages, generation: {} });
  assert.equal(gemini.contents[0].parts[1].functionCall.name, 'Vary');
  assert.equal(gemini.contents[1].parts[0].functionResponse.name, 'Vary');
});

test('Varina handoff is staged as a matching tool exchange before the main loop resumes', async () => {
  const calls = [];
  const handoff = {
    kind: 'varina_exploration_result',
    run_id: 'run-test',
    terminal: true,
    state: 'complete',
    stop_reason: 'required_rounds_complete',
    rounds_executed: 1,
    max_rounds: 1,
    meeting_board: {
      version: 2,
      points: [{
        id: 'P003', type: 'mechanism', status: 'active',
        text: 'Use task boundaries.', failure_condition: 'No boundary is observable.'
      }]
    },
    fact_ledger: [{
      fact_id: 'F001', fact_ref: 'F001', claim: 'A task boundary exists.',
      status: 'confirmed', semantic_summary: 'The file says so.', evidence: []
    }],
    board_changes: [{ action: 'update', fact_id: 'F001' }],
    solutions: [],
    baseline_solutions: [],
    rejected_directions: [],
    unresolved_questions: ['Boundary ownership is unresolved.'],
    degradations: [],
    repository_snapshot_id: 'snapshot-1',
    baseline_point_ids: ['P003'],
    loaded_files_manifest: [],
    decomposition: null,
    subproblem_expansion: null
  };
  const gateway = {
    async invoke(request) {
      calls.push(request);
      if (request.phase !== 'agent_turn') throw new Error(`unexpected phase ${request.phase}`);
      if (request.context.phase !== 'varina_continuation') {
        return { message: 'baseline answer', tool_calls: [] };
      }
      assert.equal(request.modelId, 'main-model');
      assert.equal(request.tools.some(tool => tool.function.name === 'Vary'), false);
      const assistant = request.messages.at(-2);
      const tool = request.messages.at(-1);
      assert.equal(assistant.role, 'assistant');
      assert.match(assistant.content, /baseline answer/);
      assert.match(assistant.content, /机制取舍、反例和证据缺口/);
      assert.equal(assistant.tool_calls[0].function.name, 'Vary');
      assert.equal(tool.role, 'tool');
      assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
      const argumentsValue = JSON.parse(assistant.tool_calls[0].function.arguments);
      assert.equal(argumentsValue.problem, 'When should the router switch?');
      const envelope = JSON.parse(tool.content);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.result.fact_ledger[0].status, 'confirmed');
      assert.deepEqual(envelope.result.board_changes, handoff.board_changes);
      return { message: 'main agent final answer', tool_calls: [] };
    }
  };
  const state = createSessionState(process.cwd());
  const session = new AgentSession({
    state,
    host: new MemoryHost(),
    store: { async save() {} },
    gateway,
    config: {
      roles: { main: 'main-model' },
      models: [{ id: 'main-model', protocol: 'chat' }],
      max_tool_iterations: 4
    }
  });
  session.evaluateVarinaNeed = async () => ({ decision: 'START', reason: 'test' });
  session.extractBaseline = async () => ({
    task_framing: 'When should the router switch?',
    user_constraints: [],
    agent_hypotheses: [],
    points: [],
    solutions: []
  });
  session.explore = async () => {
    state.varina_runs.push({ run_id: handoff.run_id, state: 'complete' });
    return handoff;
  };

  const answer = await session.turn('When should the router switch?', { enable_varina: true });

  assert.equal(answer.content, 'main agent final answer');
  assert.equal(answer.message_kind, 'varina_addendum');
  assert.equal(answer.partial, false);
  assert.equal(answer.context_exchange.synthetic, true);
  assert.equal(answer.context_exchange.run_id, 'run-test');
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(call => call.phase === 'varina_delta').length, 0);
  assert.ok(state.messages.some(message => message.message_kind === 'baseline'));
  assert.equal(state.messages.at(-1), answer);
  assert.equal(state.varina_runs[0].final_text, 'main agent final answer');
  assert.ok(answer.steps.some(step => step.phase === 'varina_continuation'));
});
