// The engine owns the contract and sampling policy, never the card contents.
export function createOperatorPool(pool) {
  if (!Array.isArray(pool)) throw new Error('Varina 深度探索需要注入 operatorPool 数组');
  const ids = new Set();
  const snapshot = pool.map((operator, index) => {
    for (const field of ['operator_id', 'family', 'name', 'prompt']) {
      if (typeof operator?.[field] !== 'string' || !operator[field].trim()) {
        throw new Error(`operatorPool[${index}].${field} 必须是非空字符串`);
      }
    }
    if (ids.has(operator.operator_id)) throw new Error(`operatorPool 中 operator_id 重复：${operator.operator_id}`);
    ids.add(operator.operator_id);
    if (operator.enabled !== undefined && typeof operator.enabled !== 'boolean') {
      throw new Error(`operatorPool[${index}].enabled 必须是布尔值`);
    }
    return Object.freeze({
      operator_id: operator.operator_id,
      family: operator.family,
      name: operator.name,
      prompt: operator.prompt,
      enabled: operator.enabled ?? true
    });
  });
  if (new Set(snapshot.filter(operator => operator.enabled).map(operator => operator.family)).size < 3) {
    throw new Error('operatorPool 至少需要 3 个启用的算子分类');
  }
  return Object.freeze(snapshot);
}

export function random(seed) {
  let x = seed >>> 0;
  return () => { x += 0x6D2B79F5; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function sampleOperators(rng, pool) {
  const enabled = pool.filter(operator => operator.enabled);
  const availableFamilies = [...new Set(enabled.map(operator => operator.family))].sort();
  if (availableFamilies.length < 3) throw new Error('可用通用算子族不足');
  const picked = [];
  while (picked.length < 3) {
    const family = availableFamilies.splice(Math.floor(rng() * availableFamilies.length), 1)[0];
    const choices = enabled.filter(operator => operator.family === family);
    picked.push(choices[Math.floor(rng() * choices.length)]);
  }
  return picked;
}
