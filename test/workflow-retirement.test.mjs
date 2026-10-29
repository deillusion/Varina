import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, normalizeConfig, resolveActiveConfig, saveConfig, validateConfig } from '../src/config.mjs';
import { buildPayload } from '../src/provider.mjs';
import { createApp } from '../server.mjs';
import { operators as defaultOperators } from '../src/operators.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const roles = ['main', 'exploration', 'varina_gate', 'baseline_extraction', 'varina_delta', 'compaction'];
const retired = ['chair', 'dedup', 'dealer', 'decision', 'grounder', 'assembly', 'extractor'];
const customOperators = ['a', 'b', 'c'].map(id => ({
  operator_id: `external-${id}`, family: id, name: `External ${id}`, prompt: `External instruction ${id}`
}));

async function temporaryDirectory() {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'varina-retirement-'));
  return { directory, cleanup: async () => {
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^varina-retirement-/);
    await rm(directory, { recursive: true, force: true });
  } };
}

async function example() {
  return JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
}

test('new configuration works without retired roles or generation settings', async () => {
  const config = await example();
  validateConfig(config, 'mock');
  for (const key of retired) {
    assert.equal(Object.hasOwn(config.roles, key), false);
    assert.equal(Object.hasOwn(config.generation, key), false);
  }
  assert.equal(Object.hasOwn(config, 'minimumCreativeRatio'), false);
  assert.equal(Object.hasOwn(config, 'minimumDecisionRatio'), false);
  for (const role of roles) {
    const invalid = structuredClone(config);
    invalid.roles[role] = 'missing-model';
    assert.throws(() => validateConfig(invalid, 'mock'), /模型/);
  }
});

test('old configuration migrates without changing the file; saving retains credentials', async t => {
  const temp = await temporaryDirectory();
  t.after(temp.cleanup);
  const config = await example();
  config.roles = { chair: 'GEMINI', dedup: 'GLM', dealer: 'DEEPSEEK', assembly: 'GLM' };
  config.generation.chair = { temperature: 0.4, max_output_tokens: 12000 };
  config.generation.decision = { temperature: 0, max_output_tokens: 900 };
  delete config.generation.agent;
  delete config.generation.varina_gate;
  delete config.generation.varina_delta;
  config.minimumCreativeRatio = 0.5;
  config.minimumDecisionRatio = 0.5;
  config.models[0].apiKey = 'test-credential-preserved-locally';
  const filename = path.join(temp.directory, 'config.local.json');
  const original = JSON.stringify(config);
  await writeFile(filename, original);

  const migrated = await loadConfig(temp.directory, 'live', { allowKeyless: true });
  assert.deepEqual(migrated.roles, {
    main: 'GEMINI', exploration: 'GEMINI', varina_gate: 'DEEPSEEK',
    baseline_extraction: 'GLM', varina_delta: 'GLM', compaction: 'GEMINI'
  });
  assert.equal(migrated.generation.agent.max_output_tokens, 12000);
  assert.equal(migrated.generation.varina_delta.max_output_tokens, 12000);
  assert.equal(migrated.generation.varina_gate.max_output_tokens, 900);
  assert.deepEqual(normalizeConfig(migrated), migrated);
  assert.equal(await readFile(filename, 'utf8'), original);

  migrated.models[0].apiKey = '••••••••';
  migrated.roles.exploration = 'deleted-model';
  await saveConfig(temp.directory, migrated);
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(saved.models[0].apiKey, config.models[0].apiKey);
  assert.equal(saved.roles.exploration, saved.models[0].id);
  for (const key of retired) {
    assert.equal(Object.hasOwn(saved.roles, key), false);
    assert.equal(Object.hasOwn(saved.generation, key), false);
  }
  assert.equal(Object.hasOwn(saved, 'minimumCreativeRatio'), false);
  assert.equal(Object.hasOwn(saved, 'minimumDecisionRatio'), false);
});

test('explicit Agent settings take precedence over old aliases and all roles use available models', async () => {
  const config = await example();
  config.roles.chair = 'GLM';
  config.roles.dealer = 'GLM';
  config.roles.dedup = 'GLM';
  const normalized = normalizeConfig(config);
  assert.deepEqual(normalized.roles, (await example()).roles);
  assert.equal(config.roles.chair, 'GLM');
  normalized.models = normalized.models.map(model => ({
    ...model, apiKey: null, apiKeyEnv: null, isKeyless: model.id === 'DEEPSEEK'
  }));
  for (const model of normalized.models) if (model.id !== 'DEEPSEEK') model.apiKeyEnv = 'VARINA_RETIREMENT_UNUSED_KEY';
  normalized.roles = Object.fromEntries(roles.map(role => [role, 'GEMINI']));
  const { config: active, routing } = resolveActiveConfig(normalized, 'live');
  assert.deepEqual(new Set(Object.values(active.roles)), new Set(['DEEPSEEK']));
  assert.deepEqual(new Set(Object.keys(routing.remappedRoles)), new Set(roles));
  assert.ok(active.seats.every(seat => seat.modelId === 'DEEPSEEK'));
});

test('provider uses explicit schemas for both protocols without injecting old workflow schemas', async () => {
  const model = (await example()).models[2];
  const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
  const request = { phase: 'connectivity', schema, messages: [{ role: 'user', content: 'test' }] };
  const chat = buildPayload(model, request);
  assert.deepEqual(chat.response_format.json_schema.schema, schema);
  const gemini = buildPayload({ ...model, protocol: 'gemini' }, request);
  assert.deepEqual(gemini.generationConfig.responseJsonSchema, schema);
  const plain = buildPayload(model, { phase: 'creative', messages: request.messages });
  assert.equal(plain.response_format, undefined);
  assert.equal(plain.messages.length, 1);
});

for (const injected of [false, true]) {
test(`Web keeps chat, exploration and session history working with ${injected ? 'injected' : 'default'} operators`, { timeout: 30000 }, async t => {
  const temp = await temporaryDirectory();
  let app;
  t.after(async () => {
    await app?.stop();
    if (app?.server.listening) await new Promise(resolve => app.server.close(resolve));
    await temp.cleanup();
  });
  app = await createApp({
    workspaceRoot: temp.directory, sessionDataDir: path.join(temp.directory, 'sessions'),
    ...(injected ? { operatorPool: customOperators } : {})
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, input) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  });
  for (const route of ['/api/runs', '/api/runs/run-old', '/api/runs/run-old/export', '/api/runs/run-old/stream']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  for (const route of ['/api/runs', '/api/runs/run-old/cancel', '/api/simulate']) {
    assert.equal((await post(route, {})).status, 404, route);
  }
  assert.equal((await fetch(base)).status, 200);
  const overview = await (await fetch(base + '/api/config')).json();
  const expectedOperators = injected ? customOperators.map(operator => ({ ...operator, enabled: true })) : defaultOperators;
  assert.deepEqual(overview.operators, expectedOperators);
  assert.equal(overview.mockConfig.roles.chair, undefined);
  assert.equal(overview.experiments, undefined);
  assert.equal(overview.domainCatalog, undefined);

  const created = await post('/api/agent/sessions', { mode: 'mock', workspace_root: temp.directory });
  assert.equal(created.status, 201);
  const { session_id: id } = await created.json();
  async function send(message, enable_varina) {
    assert.equal((await post(`/api/agent/sessions/${id}/messages`, { message, enable_varina })).status, 202);
    for (let attempt = 0; attempt < 1500 && app.agentService.active.has(id); attempt++) await delay(10);
    assert.equal(app.agentService.active.has(id), false, 'turn should finish within the deadline');
    return (await fetch(`${base}/api/agent/sessions/${id}`)).json();
  }
  const chat = await send('帮我分析合作机制中的资源取舍', false);
  assert.equal(chat.status, 'idle');
  assert.equal(chat.varina_runs.length, 0);
  assert.equal(chat.messages.at(-1).partial, false);

  const explored = await send('/varina 设计一个十分钟内持续产生资源取舍的合作机制', true);
  assert.equal(explored.status, 'idle');
  assert.equal(explored.varina_runs.length, 1);
  const run = explored.varina_runs[0];
  assert.equal(run.rounds_executed, 5);
  assert.equal(run.stop_reason, 'required_rounds_complete');
  const expectedIds = new Set(expectedOperators.map(operator => operator.operator_id));
  for (const round of run.round_records) {
    for (const ids of Object.values(round.allocated_operators)) {
      assert.equal(ids.length, 3);
      assert.ok(ids.every(id => expectedIds.has(id)));
    }
  }
  assert.ok(run.final_meeting_board.points.length > 0);
  assert.ok(explored.messages.some(message => message.message_kind === 'baseline'));
  assert.ok(explored.messages.some(message => message.message_kind === 'varina_addendum'));
  assert.ok(explored.calls.every(call => !['chair', 'dealer', 'dedup', 'decision'].includes(call.phase)));
  const persisted = JSON.parse(await readFile(path.join(temp.directory, 'sessions', 'mock', `${id}.json`), 'utf8'));
  assert.equal(persisted.varina_runs[0].rounds_executed, 5);
  const listed = await (await fetch(base + '/api/agent/sessions')).json();
  assert.equal(listed.sessions[0].session_id, id);
});
}

for (const injected of [false, true]) {
test(`MCP executes chat and design with ${injected ? 'injected' : 'default'} operators`, { timeout: 30000 }, async t => {
  const temp = await temporaryDirectory();
  const child = spawn(process.execPath, ['--input-type=module', '--eval',
    `import { startMcpServer } from './mcp.mjs'; await startMcpServer({dataDir:process.env.VARINA_TEST_DATA_DIR${injected ? `,operatorPool:${JSON.stringify(customOperators)}` : ''}});`
  ], { cwd: root, env: { ...process.env, VARINA_WORKSPACE_ROOT: temp.directory, VARINA_TEST_DATA_DIR: path.join(temp.directory, 'sessions') }, windowsHide: true });
  let stderr = '';
  let buffer = '';
  let requestId = 0;
  const pending = new Map();
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const result = JSON.parse(line);
      if (pending.has(result.id)) { pending.get(result.id).resolve(result); pending.delete(result.id); }
    }
  });
  child.on('error', error => { for (const task of pending.values()) task.reject(error); });
  child.on('exit', code => { for (const task of pending.values()) task.reject(new Error(`MCP exited ${code}: ${stderr}`)); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await temp.cleanup();
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  assert.ok((await rpc('initialize')).result.capabilities.tools);
  const list = (await rpc('tools/list')).result.tools;
  assert.deepEqual(list.map(tool => tool.name), ['varina_chat', 'varina_design_architecture', 'aha_chat', 'aha_design_architecture']);
  for (const tool of list.filter(tool => tool.name.endsWith('design_architecture'))) {
    assert.equal(tool.inputSchema.properties.experiment, undefined);
    assert.equal(tool.inputSchema.properties.use_domain_operators, undefined);
  }
  const chat = await rpc('tools/call', { name: 'varina_chat', arguments: { message: '你好', mode: 'mock' } });
  assert.equal(chat.error, undefined);
  assert.match(chat.result.structuredContent.session_id, /^session-/);
  const design = await rpc('tools/call', { name: 'aha_design_architecture', arguments: { problem: '设计合作玩法中的资源取舍', mode: 'mock' } });
  assert.equal(design.error, undefined);
  const id = design.result.structuredContent.session_id;
  const session = JSON.parse(await readFile(path.join(temp.directory, 'sessions', 'mock', `${id}.json`), 'utf8'));
  assert.equal(session.varina_runs[0].rounds_executed, 5);
  assert.equal(session.varina_runs[0].stop_reason, 'required_rounds_complete');
  const expectedIds = new Set((injected ? customOperators : defaultOperators).map(operator => operator.operator_id));
  for (const round of session.varina_runs[0].round_records) {
    for (const ids of Object.values(round.allocated_operators)) {
      assert.equal(ids.length, 3);
      assert.ok(ids.every(id => expectedIds.has(id)));
    }
  }
});
}
