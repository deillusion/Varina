import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOperatorPool, random, sampleOperators } from '../src/varina/operator_pool.mjs';
import { operators, sampleOperators as sampleDefault } from '../src/operators.mjs';
import { VaryEngine } from '../src/varina/vary.mjs';

function pool() {
  return ['one', 'two', 'three'].flatMap(family => [1, 2].map(index => ({
    operator_id: `${family}-${index}`, family, name: `${family} ${index}`, prompt: `Instruction ${family} ${index}`
  })));
}

test('sampling preserves three distinct families, disabled filtering and seeded repeatability', () => {
  const cards = createOperatorPool([
    ...pool(),
    { operator_id: 'disabled', family: 'four', name: 'Disabled', prompt: 'Never select', enabled: false }
  ]);
  const draws = seed => {
    const rng = random(seed);
    return Array.from({ length: 20 }, () => sampleOperators(rng, cards).map(operator => operator.operator_id));
  };
  assert.deepEqual(draws(42), draws(42));
  assert.notDeepEqual(draws(42), draws(43));
  for (const ids of draws(42)) {
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids.map(id => id.split('-')[0])).size, 3);
    assert.equal(ids.includes('disabled'), false);
  }
  assert.ok(Object.isFrozen(cards));
  assert.ok(cards.every(Object.isFrozen));
});

test('invalid injected pools fail with a concrete error', () => {
  const invalid = [
    [undefined, /需要注入 operatorPool 数组/],
    [null, /需要注入 operatorPool 数组/],
    [{}, /需要注入 operatorPool 数组/],
    [[], /至少需要 3 个启用的算子分类/],
    [[...pool(), pool()[0]], /operator_id 重复/],
    [pool().map(operator => ({ ...operator, family: 'same' })), /至少需要 3 个启用的算子分类/],
    [pool().map(operator => ({ ...operator, enabled: false })), /至少需要 3 个启用的算子分类/],
    [[...pool(), { ...pool()[0], operator_id: 'extra', enabled: 'true' }], /enabled 必须是布尔值/]
  ];
  for (const field of ['operator_id', 'family', 'name', 'prompt']) {
    invalid.push([[{ ...pool()[0], [field]: '  ' }, ...pool().slice(1)], new RegExp(`${field} 必须是非空字符串`)]);
  }
  for (const [value, expected] of invalid) assert.throws(() => createOperatorPool(value), expected);
  assert.throws(() => new VaryEngine({}), /需要注入 operatorPool 数组/);
});

test('default library keeps existing seeded selection and compatibility exports', () => {
  const cards = createOperatorPool(operators);
  const originalRng = random(2026);
  const injectedRng = random(2026);
  // Recorded from the pre-injection library with seed 2026.
  const expected = [
    ['premortem', 'one_line', 'hidden_motivation'],
    ['substitute', 'inversion', 'incentive'],
    ['counterexample', 'hidden_premise', 'adaptation'],
    ['feedback', 'hidden_premise', 'representation_test'],
    ['metaphor', 'hidden_premise', 'premortem']
  ];
  for (const ids of expected) {
    assert.deepEqual(sampleOperators(injectedRng, cards).map(operator => operator.operator_id), ids);
    assert.deepEqual(sampleDefault(originalRng).map(operator => operator.operator_id), ids);
  }
});

test('core dependency graph never imports built-in operator contents', async () => {
  const visited = new Set();
  async function inspect(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    assert.notEqual(url.href, new URL('../src/operators.mjs', import.meta.url).href);
    const source = await readFile(url, 'utf8');
    const imports = [...source.matchAll(/(?:import|export)\s+(?:[^;'"\n]+?\s+from\s+)?['"]([^'"]+)['"]/g)];
    for (const [, specifier] of imports) {
      if (specifier.startsWith('.')) await inspect(new URL(specifier, url));
    }
  }
  for (const file of ['agent/agent_service.mjs', 'agent/agent_session.mjs', 'varina/vary.mjs', 'application/config_service.mjs']) {
    await inspect(new URL(`../src/${file}`, import.meta.url));
  }
  assert.ok(visited.has(new URL('../src/varina/operator_pool.mjs', import.meta.url).href));
});
