// Shared, environment-independent checks for the tool contracts.
export function toolError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

export function requireText(value, field, { max = 20000, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw toolError('INVALID_ARGUMENT',
      field + ' 必须显式提供字符串' + (allowEmpty ? '，允许空字符串' : '，且不能为空或纯空白'),
      { field, allow_empty: allowEmpty });
  }
  if (value.length > max) {
    throw toolError('ARGUMENT_TOO_LONG', field + ' 最多允许 ' + max + ' 字符，实际 ' + value.length + ' 字符',
      { field, max_length: max, actual_length: value.length });
  }
}

export function validateGlobPattern(pattern, field = 'pattern') {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw toolError('INVALID_GLOB', field + ' 必须是非空的路径匹配模式', { field });
  }
  if (/[{}\[\]]|[!+@?*]\(/.test(pattern)) {
    throw toolError('UNSUPPORTED_GLOB',
      field + ' 只支持 *、**、?，不支持花括号、字符类或 extglob；请拆成多次调用',
      { field, pattern, supported: ['*', '**', '?'] });
  }
}

export function validateResultLimit(value, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw toolError('INVALID_MAX_RESULTS', 'max_results 必须是 1–' + max + ' 的整数',
      { field: 'max_results', minimum: 1, maximum: max, actual: value });
  }
}

export function searchMatcher(query, isRegex = false) {
  if (typeof query !== 'string' || !query.length || query.length > 500) {
    throw toolError('INVALID_QUERY', 'query 必须是 1–500 字符的字符串',
      { field: 'query', minimum_length: 1, maximum_length: 500 });
  }
  if (typeof isRegex !== 'boolean') {
    throw toolError('INVALID_ARGUMENT', 'is_regex 必须是布尔值', { field: 'is_regex' });
  }
  if (!isRegex) return null;
  if (query.length > 200) {
    throw toolError('REGEX_TOO_LONG', '正则表达式最多允许 200 字符，实际 ' + query.length + ' 字符；请缩短或拆分检索',
      { field: 'query', maximum_length: 200, actual_length: query.length });
  }
  if (/\\[1-9]/.test(query)) {
    throw toolError('UNSUPPORTED_REGEX_BACKREFERENCE', '正则检索不支持数字反向引用；请去掉反向引用或拆分检索',
      { field: 'query' });
  }
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(query) || /\.[*+]\s*\.[*+]/.test(query)) {
    throw toolError('UNSAFE_REGEX', '正则包含不支持的嵌套或连续无界重复量词；请简化量词或拆分检索',
      { field: 'query' });
  }
  try { return new RegExp(query, 'iu'); }
  catch (error) {
    throw toolError('INVALID_REGEX', '正则表达式语法无效，请检查括号、方括号和转义：' + error.message,
      { field: 'query' });
  }
}

export function validateSearchArguments(name, args) {
  if (args.max_results !== undefined) validateResultLimit(args.max_results, 500);
  if (name === 'Glob') {
    validateGlobPattern(args.pattern === undefined ? '**/*' : args.pattern);
  } else {
    validateGlobPattern(args.path_filter === undefined ? '**/*' : args.path_filter, 'path_filter');
    searchMatcher(args.query, args.is_regex === undefined ? false : args.is_regex);
  }
}

export function validateWriteArguments(args) {
  requireText(args.file_path, 'file_path');
  requireText(args.content, 'content', { max: 500000, allowEmpty: true });
  if (args.expected_hash !== null) requireText(args.expected_hash, 'expected_hash');
}

export function validateEditArguments(args) {
  requireText(args.file_path, 'file_path', { max: 50000 });
  // Whitespace is meaningful when replacing text, but an empty search is not.
  requireText(args.old_string, 'old_string', { max: 50000, allowEmpty: true });
  if (!args.old_string.length) {
    throw toolError('INVALID_ARGUMENT', 'old_string 不能为空；请提供恰好匹配一次的原文',
      { field: 'old_string' });
  }
  requireText(args.new_string, 'new_string', { max: 200000, allowEmpty: true });
  requireText(args.expected_hash, 'expected_hash', { max: 50000 });
}
