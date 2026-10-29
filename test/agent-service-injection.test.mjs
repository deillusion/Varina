import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../src/agent/agent_service.mjs';
import { mockStructuredCompletion } from '../src/agent/model_gateway.mjs';
import { MemoryHost } from '../src/host/node_fs_host.mjs';

function injectedConfig() {
  return {
    models: [{ id: 'main-model' }, { id: 'creative-model' }],
    roles: { main: 'main-model', exploration: 'main-model' },
    seats: [{ id: 'Z1', modelId: 'creative-model' }, { id: 'Z2', modelId: 'creative-model' }],
    exploration: { rounds: 1, maxReactSteps: 4 },
    decomposition: { enabled: true, seatCount: 2, maxRounds: 2, maxQuestionsPerSeat: 4, maxAcceptedSubproblems: 20 },
    subproblemExpansion: { enabled: false }
  };
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

const testOperators = freeze([
  ...['a', 'b', 'c'].map(id => ({
    operator_id: `private-${id}`, family: id, name: `Private ${id}`, prompt: `Private instruction ${id}`
  })),
  { operator_id: 'disabled', family: 'd', name: 'Disabled', prompt: 'Do not assign this card', enabled: false }
]);

function harness(config = freeze(injectedConfig()), decision = 'START', dependencies = { operatorPool: testOperators }) {
  const states = new Map();
  const requests = [];
  const gatewayOptions = [];
  const decisionOptions = [];
  const decisions = [];
  const events = [];
  const service = new AgentService({
    ...dependencies,
    workspaceHost: {
      root: 'memory://project',
      async init() {},
      async resolve(requested) { return requested ?? this.root; }
    },
    store: {
      async init() {},
      async list() { return [...states.values()]; },
      async save(state) { states.set(state.session_id, state); },
      async get(id) { return states.get(id); }
    },
    configLoader: async () => config,
    hostFactory: () => new MemoryHost(),
    gatewayFactory: (received, options) => {
      assert.equal(received, config, 'injected routing and models must pass through unchanged');
      gatewayOptions.push(options);
      return { async invoke(request) {
        options.signal.throwIfAborted();
        requests.push(request);
        options.onCall({ phase: request.phase, model_id: request.modelId, status: 'completed' });
        return mockStructuredCompletion(request);
      } };
    },
    decisionGatewayFactory: (received, options) => {
      assert.equal(received, config);
      const instance = decisionOptions.push(options);
      const record = kind => {
        options.signal.throwIfAborted();
        decisions.push({ instance, kind });
        options.onCall({ phase: kind, model_id: 'injected-decision', status: 'completed' });
      };
      return {
        async evaluateVarinaNeed() {
          record('gate');
          return { decision, reason: 'injected decision' };
        },
        async evaluateSubproblemRedundancy({ candidateSubproblems }) {
          record('subproblem-dedup');
          return { decisions: candidateSubproblems.map(item => ({ candidate_id: item.candidate_id, duplicate: false })) };
        },
        async evaluateIdeaRedundancy() {
          record('idea-dedup');
          return { duplicate: false };
        }
      };
    }
  });
  return { service, states, requests, gatewayOptions, decisionOptions, decisions, events,
    async create() {
      const state = await service.create({ mode: 'live' });
      service.subscribe(state.session_id, event => events.push(event));
      return state;
    }
  };
}

test('live sessions use injected models without credential metadata or routing changes', async t => {
  const h = harness();
  t.after(() => h.service.stop());
  const state = await h.create();
  const answer = await h.service.turn(state.session_id, 'hello', { enable_varina: false });
  assert.equal(answer.partial, false);
  assert.equal(state.status, 'idle');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].modelId, 'main-model');
  assert.equal(h.decisionOptions.length, 1);
});

for (const needsConfirmation of [false, true]) {
  test(`injected exploration keeps decision capabilities ${needsConfirmation ? 'after user confirmation' : 'when started directly'}`, async t => {
    const h = harness(undefined, needsConfirmation ? 'ASK' : 'START');
    t.after(() => h.service.stop());
    const state = await h.create();
    let answer = await h.service.turn(state.session_id, '设计合作玩法的资源取舍', { enable_varina: true });
    if (needsConfirmation) {
      assert.equal(state.status, 'awaiting_varina_confirmation');
      assert.equal(state.varina_runs.length, 0);
      const started = await h.service.startVarinaConfirmation(state.session_id, state.pending_confirmation.id, true);
      answer = await started.completion;
    }
    const instance = needsConfirmation ? 2 : 1;
    assert.equal(h.decisionOptions.length, instance);
    assert.equal(h.gatewayOptions.length, instance);
    const options = h.decisionOptions.at(-1);
    assert.equal(options.mode, 'live');
    assert.equal(options.signal, h.gatewayOptions.at(-1).signal);
    if (needsConfirmation) assert.notEqual(options.signal, h.decisionOptions[0].signal);
    assert.equal(answer.partial, false);
    assert.equal(answer.message_kind, 'varina_addendum');
    assert.equal(state.status, 'idle');
    assert.equal(state.varina_runs[0].state, 'complete');
    assert.equal(state.varina_runs[0].decomposition.dedup_incomplete, false);
    assert.equal(state.varina_runs[0].decomposition.round_records.length, 2);
    assert.ok(h.decisions.some(call => call.instance === instance && call.kind === 'subproblem-dedup'));
    assert.ok(h.decisions.some(call => call.instance === instance && call.kind === 'idea-dedup'));
    assert.equal(h.decisions.filter(call => call.kind === 'gate').length, 1);
    assert.ok(h.requests.filter(call => call.phase === 'varina_seat').every(call => call.modelId === 'creative-model'));
    const seatCalls = h.requests.filter(call => call.phase === 'varina_seat');
    assert.ok(seatCalls.length > 0);
    for (const call of seatCalls) {
      const suffix = call.messages.at(-1).content;
      for (const operator of testOperators.filter(item => item.enabled !== false)) {
        assert.ok(suffix.includes(`- ${operator.operator_id} ${operator.name}: ${operator.prompt}`));
      }
      assert.equal(suffix.includes('Do not assign this card'), false);
      assert.equal(suffix.split('\n- ').length - 1, 3);
    }
    for (const round of state.varina_runs[0].round_records) {
      for (const ids of Object.values(round.allocated_operators)) {
        assert.deepEqual(new Set(ids), new Set(['private-a', 'private-b', 'private-c']));
      }
    }
    assert.ok(state.calls.some(call => call.phase === 'idea-dedup'));
    assert.ok(h.events.some(event => event.event === 'model_call' && event.phase === 'idea-dedup' && event.session_id === state.session_id));
  });
}

test('operator injection snapshots caller data before exploration', async t => {
  const pool = structuredClone(testOperators);
  const h = harness(undefined, 'START', { operatorPool: pool });
  t.after(() => h.service.stop());
  pool[0].prompt = 'changed after injection';
  pool.splice(1);
  const state = await h.create();
  const answer = await h.service.turn(state.session_id, '设计合作玩法的资源取舍', { enable_varina: true });
  assert.equal(answer.partial, false);
  const calls = h.requests.filter(call => call.phase === 'varina_seat');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.messages.at(-1).content.includes('Private instruction a')));
  assert.ok(calls.every(call => !call.messages.at(-1).content.includes('changed after injection')));
});

test('chat can run without an operator pool; exploration reports missing injection without a built-in fallback', async t => {
  const h = harness(undefined, 'START', {});
  t.after(() => h.service.stop());
  const state = await h.create();
  const chat = await h.service.turn(state.session_id, 'hello', { enable_varina: false });
  assert.equal(chat.partial, false);
  await h.service.turn(state.session_id, '设计合作玩法的资源取舍', { enable_varina: true });
  assert.equal(h.requests.some(call => call.phase === 'varina_seat'), false);
  assert.ok(JSON.stringify(state).includes('需要注入 operatorPool 数组'));
  assert.equal(state.varina_runs.length, 0);
});

test('declining exploration does not recreate host or gateway dependencies', async t => {
  const h = harness(undefined, 'ASK');
  t.after(() => h.service.stop());
  const state = await h.create();
  await h.service.turn(state.session_id, 'hello', { enable_varina: true });
  const requestCount = h.requests.length;
  const started = await h.service.startVarinaConfirmation(state.session_id, state.pending_confirmation.id, false);
  await started.completion;
  assert.equal(h.gatewayOptions.length, 1);
  assert.equal(h.decisionOptions.length, 1);
  assert.equal(h.requests.length, requestCount);
  assert.equal(state.varina_runs.length, 0);
  assert.equal(state.status, 'idle');
  assert.equal(state.pending_confirmation, undefined);
});

test('invalid injected model references fail without silently remapping roles or seats', async t => {
  const cases = [
    [config => { config.models = []; }, /模型列表不能为空/],
    [config => { config.models.push({ id: 'main-model' }); }, /ID 必须非空且唯一/],
    [config => { config.roles.main = 'missing'; }, /main 必须引用/],
    [config => { config.roles.exploration = 'missing'; }, /角色 exploration/],
    [config => { config.seats[0].modelId = 'missing'; }, /席位 Z1/]
  ];
  for (const [change, expected] of cases) {
    await t.test(expected.source, async () => {
      const config = injectedConfig();
      change(config);
      const h = harness(freeze(config));
      const state = await h.create();
      const answer = await h.service.turn(state.session_id, 'hello');
      assert.match(answer.content, expected);
      assert.equal(state.status, 'failed');
      assert.equal(h.gatewayOptions.length, 0);
      assert.equal(h.decisionOptions.length, 0);
      await h.service.stop();
    });
  }
});
