const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const integer = { type: 'integer' };
const array = items => ({ type: 'array', items });
const object = properties => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false
});

export const POINT_TYPES = Object.freeze([
  'proposal', 'mechanism', 'argument', 'counterexample', 'modification',
  'connection', 'assumption', 'reframing', 'other'
]);

export const AGENT_TOOL_NAMES = Object.freeze([
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'RestoreBackup', 'ListBackups'
]);

export const INIT_AGENT_TOOL_NAMES = Object.freeze(['Read', 'Glob', 'Grep', 'InitProject']);

export const ALL_AGENT_TOOL_SPECS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'Read',
      description: '读取工作区文件内容（支持行号切片）',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '相对工作区根目录的文件路径' },
          start_line: { type: 'integer', description: '起始行号（从 1 开始，包含）' },
          end_line: { type: 'integer', description: '结束行号（包含）' }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: '按工作区相对路径匹配文件，不区分大小写。只支持 *、**、?；不支持 {a,b}、[ab] 或 extglob，请拆成多次调用。默认跳过隐藏项及 .git/node_modules/dist/build/.varina/.aha。结果达到 max_results 时可能未搜全，请缩小范围；空列表不证明文件不存在。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', minLength: 1, description: '工作区相对路径模式，仅支持 *、**、?，默认 **/*，如 src/**/*.mjs' },
          max_results: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回 1–500 个结果，默认 200；不会自动调整非法值' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: '逐行检索工作区文本，不区分大小写，不跨行。沿用 Glob 的模式限制和排除规则，最多扫描 5000 个候选文件，跳过超过 2 MiB 或二进制文件。正则最长 200 字符，不支持数字反向引用、嵌套或连续无界重复量词。命中行超过 500 字符时返回截短预览及 truncated/line_chars；结果达到 max_results 时可能未搜全，空列表不证明内容不存在。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500, description: '普通检索词为 1–500 字符；is_regex=true 时正则最长 200 字符' },
          is_regex: { type: 'boolean', description: '是否使用 JavaScript 正则，默认 false；检索均忽略大小写' },
          path_filter: { type: 'string', minLength: 1, description: '工作区相对路径过滤，仅支持 *、**、?，默认 **/*' },
          max_results: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回 1–500 条命中，默认 100；不会自动调整非法值' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: '按字面文本替换文件中恰好出现一次的原文块，不解释 $& 等替换符。仅在用户当前消息明确要求修改文件时调用。先 Read 获取 contentHash 和无渲染行号的原文（换行使用 LF），再提供 expected_hash；版本变化须重新 Read。覆盖前自动备份，new_string="" 表示删除原文块。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', minLength: 1, maxLength: 50000, description: '工作区相对路径，非空白，最多 50000 字符' },
          old_string: { type: 'string', minLength: 1, maxLength: 50000, description: '从 Read 正文复制、恰好匹配一次的非空文本，允许纯空白，最多 50000 字符' },
          new_string: { type: 'string', maxLength: 200000, description: '按字面写入的新文本，允许空字符串（删除）及纯空白，最多 200000 字符' },
          expected_hash: { type: 'string', minLength: 1, maxLength: 50000, description: '最近一次 Read 返回的 contentHash，不是片段的哈希' }
        },
        required: ['file_path', 'old_string', 'new_string', 'expected_hash'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: '写入完整文件内容。仅在用户当前消息明确要求写入文件时调用。三个参数全部必填：新建时 expected_hash=null，覆盖前先 Read 并复制 contentHash。必须显式提供 content，只有 content="" 才表示清空文件；缺失或 null 会拒绝。覆盖前自动备份，版本变化须重新 Read。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', minLength: 1, maxLength: 20000, description: '工作区相对路径，非空白，最多 20000 字符' },
          content: { type: 'string', maxLength: 500000, description: '必填的完整文件内容，最多 500000 字符；允许空字符串以明确清空文件' },
          expected_hash: { type: ['string', 'null'], minLength: 1, maxLength: 20000, description: '必填；覆盖时复制 Read 返回的 contentHash，新建时显式传 null' }
        },
        required: ['file_path', 'content', 'expected_hash'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'InitProject',
      description: '初始化或更新 VARINA.md 项目心智模型。仅在用户输入 /init 时调用',
      parameters: {
        type: 'object',
        properties: {
          manifest: { type: 'object', description: '项目清单对象' }
        },
        required: ['manifest'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'RestoreBackup',
      description: '从备份恢复文件',
      parameters: {
        type: 'object',
        properties: {
          backup_id: { type: 'string', description: '备份 ID' }
        },
        required: ['backup_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ListBackups',
      description: '列出可恢复的备份',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: ['string', 'null'], description: '指定文件路径，若为 null 则列出所有备份' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Vary',
      description: '触发 Varina 深度设计探索流水线，推演多视角机制组合与系统取舍',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: '短小中立的任务定义' },
          user_constraints: {
            type: 'array',
            description: '从用户原话中直接摘录的约束列表',
            items: {
              type: 'object',
              properties: {
                constraint: { type: 'string' },
                source_quote: { type: 'string' }
              },
              required: ['constraint', 'source_quote'],
              additionalProperties: false
            }
          },
          source_excerpts: {
            type: 'array',
            description: '从已 Read 文件中提取的真实高信息量行范围',
            items: {
              type: 'object',
              properties: {
                source_path: { type: 'string' },
                start_line: { type: 'integer' },
                end_line: { type: 'integer' }
              },
              required: ['source_path', 'start_line', 'end_line'],
              additionalProperties: false
            }
          },
          agent_hypotheses: {
            type: 'array',
            description: 'Agent 提出的可被挑战的假说',
            items: { type: 'string' }
          },
          relevant_files: {
            type: 'array',
            description: '本轮或此前由 Read 实际加载过的文件路径',
            items: { type: 'string' }
          }
        },
        required: ['problem'],
        additionalProperties: false
      }
    }
  }
]);

const selectTools = names => Object.freeze(ALL_AGENT_TOOL_SPECS.filter(spec => names.includes(spec.function.name)));

export const AGENT_TOOL_SPECS = selectTools(AGENT_TOOL_NAMES);
export const INIT_AGENT_TOOL_SPECS = selectTools(INIT_AGENT_TOOL_NAMES);
export const VARY_TOOL_SPEC = ALL_AGENT_TOOL_SPECS.find(spec => spec.function.name === 'Vary');

export const agentTurnSchema = object({
  message: string,
  tool_calls: array(object({
    id: string,
    name: { type: 'string', enum: AGENT_TOOL_NAMES },
    arguments_json: string
  })),
  done: { type: 'boolean' }
});

export const seatResponseSchema = object({
  seat_id: string,
  packet_token: string,
  analysis_summary: string,
  contributions: array(object({
    local_id: string,
    type: { type: 'string', enum: POINT_TYPES },
    text: string,
    failure_condition: string
  })),
  verification_requests: array(object({
    claim_id: string,
    claim: string,
    why_it_matters: string,
    search_hints: array(string),
    affected_local_ids: array(string)
  }))
});

export const decompositionSeatResponseSchema = object({
  questions: array(string)
});

export const subproblemAnswerResponseSchema = object({
  elements: array(object({
    type: { type: 'string', enum: POINT_TYPES },
    text: string,
    failure_condition: string
  }))
});

const evidenceSchema = object({
  filePath: string,
  lineRange: array(integer),
  symbol: nullableString,
  snippet: string,
  content_hash: string
});

export const groundingSchema = object({
  facts: array(object({
    fact_ref: string,
    claim: string,
    status: { type: 'string', enum: ['confirmed', 'contradicted', 'partially_true', 'unknown', 'stale'] },
    evidence_strength: { type: 'string', enum: ['unverified', 'documentary', 'structural', 'reachable', 'runtime', 'coverage'] },
    evidence: array(evidenceSchema),
    search_coverage: array(string),
    correction: nullableString,
    semantic_summary: string,
    affected_candidate_ids: array(string)
  })),
  load_requests: array(object({
    request_id: string,
    claim_ref: string,
    reason: string,
    search_hints: array(string),
    candidate_paths: array(string),
    blocking: { type: 'boolean' }
  }))
});

export const dedupSchema = object({
  operations: array(object({
    action: { type: 'string', enum: ['ADD', 'MERGE', 'DROP'] },
    candidate_ids: array(string),
    target_point_id: nullableString,
    text: nullableString,
    failure_condition: nullableString,
    type: { type: ['string', 'null'], enum: [...POINT_TYPES, null] },
    reason: nullableString,
    duplicate_of: nullableString,
    evidence_refs: array(string)
  }))
});

export const assemblySchema = object({
  solutions: array(object({
    solution_id: string,
    name: string,
    core_mechanism_ids: array(string),
    defensive_patch_ids: array(string),
    inherent_costs: array(string)
  })),
  unresolved_questions: array(string)
});

export const varinaGateSchema = object({
  decision: { type: 'string', enum: ['START', 'ASK'] },
  reason: string
});

export const baselineExtractionSchema = object({
  task_framing: string,
  user_constraints: array(object({
    constraint: string,
    source_quote: string
  })),
  agent_hypotheses: array(string),
  points: array(object({
    local_id: string,
    type: { type: 'string', enum: POINT_TYPES },
    text: string,
    failure_condition: string,
    source_quote: string
  })),
  solutions: array(object({
    local_id: string,
    title: string,
    text: string,
    source_quote: string
  }))
});

export const varinaDeltaSchema = object({
  text: string
});

export const agentSchemas = Object.freeze({
  agent_turn: agentTurnSchema,
  varina_gate: varinaGateSchema,
  baseline_extraction: baselineExtractionSchema,
  varina_delta: varinaDeltaSchema,
  varina_decomposition_seat: decompositionSeatResponseSchema,
  varina_subproblem_answer: subproblemAnswerResponseSchema,
  varina_seat: seatResponseSchema,
  varina_grounder: groundingSchema,
  varina_dedup: dedupSchema,
  varina_assembly: assemblySchema,
  aha_seat: seatResponseSchema,
  aha_grounder: groundingSchema,
  aha_dedup: dedupSchema,
  aha_assembly: assemblySchema
});

export function validateJsonSchema(value, schema, path = '$') {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (!allowedTypes.includes(actual) && !(actual === 'integer' && allowedTypes.includes('number'))) {
    throw new Error(`${path} 类型错误，期望 ${allowedTypes.join('|')}，实际 ${actual}`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} 枚举值无效`);
  if (actual === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} 缺失`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) throw new Error(`${path}.${key} 未定义`);
        continue;
      }
      validateJsonSchema(child, properties[key], `${path}.${key}`);
    }
  }
  if (actual === 'array') value.forEach((item, index) => validateJsonSchema(item, schema.items, `${path}[${index}]`));
  return value;
}

export function cleanJsonText(text) {
  if (typeof text !== 'string') return '';
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }
  return cleaned;
}

export function parseStructuredJson(text, schema) {
  if (typeof text !== 'string') throw new Error('模型未返回有效文本');
  const cleaned = cleanJsonText(text);
  let value;
  try { value = JSON.parse(cleaned); }
  catch { throw new Error('模型未返回有效 JSON'); }
  if (schema) return validateJsonSchema(value, schema);
  return value;
}
