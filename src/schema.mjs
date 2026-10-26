export function assert(condition, message) { if (!condition) throw new Error(`校验失败：${message}`); }
// A single schema node may be missing when a caller walks a value whose keys are not declared.
// Reporting it as a validation failure keeps model output from crashing the validator itself.
function checkType(value, schema, path) {
  const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const matches = ts.includes(type) || (type === 'number' && ts.includes('integer') && Number.isInteger(value));
  assert(matches, `${path} 类型错误`);
  return type;
}
export function validateSchema(value, schema, path = '$') {
  assert(schema !== null && typeof schema === 'object', `${path} 缺少可校验的 schema 定义`);
  const type = checkType(value, schema, path);
  if (schema.enum) assert(schema.enum.includes(value), `${path} 枚举值错误`);
  if (type === 'object') {
    for (const key of schema.required ?? []) assert(Object.hasOwn(value, key), `${path}.${key} 缺失`);
    const properties = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      // Object.hasOwn, never a truthiness check: a key named like a prototype member must stay undeclared.
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) throw new Error(`校验失败：${path}.${key} 未定义（该字段不在 schema 允许的属性中，请删除）`);
        continue;
      }
      if (properties[key] != null) validateSchema(v, properties[key], `${path}.${key}`);
    }
  }
  if (type === 'array') value.forEach((v, i) => validateSchema(v, schema.items, `${path}[${i}]`));
}
