import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { loadNodeAgentConfig } from '../src/host/node_agent_config.mjs';

test('default Node loader supplies only available models with resolved roles and seats', async t => {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'varina-node-config-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^varina-node-config-/);
    await rm(directory, { recursive: true, force: true });
  });
  const input = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  const absentKey = `VARINA_TEST_ABSENT_${randomUUID().replaceAll('-', '')}`;
  input.models = input.models.map(model => ({ ...model, apiKey: null, apiKeyEnv: absentKey, isKeyless: false }));
  input.models[0].apiKey = 'test-provider-key';
  const availableId = input.models[0].id;
  const unavailableId = input.models[1].id;
  input.roles = Object.fromEntries(Object.keys(input.roles).map(role => [role, unavailableId]));
  input.seats = input.seats.map(seat => ({ ...seat, modelId: unavailableId }));
  const filename = path.join(directory, 'config.local.json');
  const original = JSON.stringify(input);
  await writeFile(filename, original);

  const config = await loadNodeAgentConfig(directory, 'live');
  assert.deepEqual(config.models.map(model => model.id), [availableId]);
  assert.ok(Object.values(config.roles).every(modelId => modelId === availableId));
  assert.ok(config.seats.every(seat => seat.modelId === availableId));
  assert.equal(await readFile(filename, 'utf8'), original, 'loading must preserve the full saved configuration');
});

test('default Node loader keeps every model in mock mode', async () => {
  const input = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  const config = await loadNodeAgentConfig(undefined, 'mock');
  assert.deepEqual(config.models.map(model => model.id), input.models.map(model => model.id));
  assert.ok(config.models.every(model => model.baseUrl === 'mock://local' && model.apiKeyEnv === null));
});
