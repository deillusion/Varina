import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { AgentSession, createSessionState } from '../src/agent/agent_session.mjs';
import { AGENT_TOOL_SPECS } from '../src/agent/schemas.mjs';
import { ExplorationReact, EXPLORATION_TOOLS } from '../src/varina/react.mjs';
import { MemoryHost, NodeFsHost } from '../src/host/node_fs_host.mjs';

let nextId = 0;
const call = (name, args) => ({ id: 'contract-' + ++nextId, name, arguments_json: JSON.stringify(args) });

function agent(host) {
  const session = new AgentSession({
    state: createSessionState('contract-test'), host, store: { async save() {} }, config: {}
  });
  return (name, args) => session.executeTool(call(name, args), '请修改文件');
}

function exploration(host = new MemoryHost({ 'source.txt': 'The original source.\nSecond line.' })) {
  const runtime = {
    run_id: 'contract-test', original_user_request: 'Check the repository.',
    current_board: { version: 1, points: [
      { id: 'P001', revision: 1, status: 'active', text: 'Original point.' },
      { id: 'P002', revision: 1, status: 'active', text: 'Another point.' }
    ] },
    fact_ledger: [], board_history: [], board_changes: [],
    verification_requests: [
      { fact_ref: 'R1:Z1:V1', claim: 'Original claim.', affected_point_ids: ['P001'], status: 'pending' },
      { fact_ref: 'R1:Z2:V1', claim: 'Other claim.', affected_point_ids: ['P002'], status: 'pending' }
    ],
    round_records: [{ round_index: 1 }], max_rounds: 1
  };
  const react = new ExplorationReact({
    runtime, host, config: {}, checkpoint: async () => {}, onEvent: () => {}, refreshSources: async () => {}
  });
  return { runtime, react, invoke: async (name, args) => (await react.appendResults([call(name, args)]))[0] };
}

const updateArgs = (fact = {}) => ({
  item_id: 'P001', expected_revision: 1, action: 'update', reason: 'Checked the claim.',
  patch: { text: 'Revised point.', fact: {
    claim: 'Original claim.', claim_ref: 'R1:Z1:V1', status: 'unknown',
    explanation: 'More evidence is needed.', evidence: [], ...fact
  } }
});
const boardState = runtime => structuredClone({
  board: runtime.current_board, facts: runtime.fact_ledger, requests: runtime.verification_requests,
  changes: runtime.board_changes, history: runtime.board_history, rounds: runtime.round_records
});

test('claim reference errors identify the problem and support a successful retry', async () => {
  for (const [fact, code] of [
    [{ claim_ref: 'P001' }, 'CLAIM_REF_NOT_FOUND'],
    [{ claim_ref: 'R1:Z2:V1', claim: 'Other claim.' }, 'CLAIM_REF_POINT_MISMATCH'],
    [{ claim: 'Original claim' }, 'CLAIM_TEXT_MISMATCH']
  ]) {
    const { invoke, runtime } = exploration();
    const before = boardState(runtime);
    const failed = await invoke('UpdateBoardItem', updateArgs(fact));
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, code);
    assert.deepEqual(boardState(runtime), before, 'rejected update must be atomic');
    const details = failed.error.details;
    const correction = details.available_claims?.[0] ?? {
      fact_ref: details.claim_ref, claim: details.expected_claim
    };
    assert.equal(correction.fact_ref, 'R1:Z1:V1');
    assert.equal(correction.claim, 'Original claim.');
    const retried = await invoke('UpdateBoardItem', updateArgs({
      claim_ref: correction.fact_ref, claim: correction.claim
    }));
    assert.equal(retried.ok, true);
    assert.equal(retried.result.item.revision, 2);
    assert.equal(runtime.verification_requests[0].status, 'unknown');
    assert.equal(runtime.verification_requests[1].status, 'pending');
    assert.equal(runtime.fact_ledger[0].fact_ref, correction.fact_ref);
  }
});

test('independent facts can omit a reference without resolving an unrelated pending request', async () => {
  const { invoke, runtime } = exploration();
  const args = updateArgs({ claim: 'An independent design choice.', status: 'not_applicable' });
  delete args.patch.fact.claim_ref;
  assert.equal((await invoke('UpdateBoardItem', args)).ok, true);
  assert.equal(runtime.fact_ledger[0].fact_ref, 'F001');
  assert.equal(runtime.verification_requests[0].status, 'pending');
});

test('board conflicts and fact status errors give actionable results without modifying the board', async () => {
  const { invoke, runtime } = exploration();
  const before = boardState(runtime);
  for (const [args, code] of [
    [{ ...updateArgs(), item_id: 'missing' }, 'BOARD_ITEM_NOT_FOUND'],
    [updateArgs({ status: 'not_applicable' }), 'CLAIM_STATUS_INVALID'],
    [updateArgs({ status: 'confirmed' }), 'EVIDENCE_REQUIRED']
  ]) {
    const failed = await invoke('UpdateBoardItem', args);
    assert.equal(failed.error.code, code);
    assert.deepEqual(boardState(runtime), before);
  }
  const conflict = await invoke('UpdateBoardItem', { ...updateArgs(), expected_revision: 0 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.result.code, 'REVISION_CONFLICT');
  assert.equal(conflict.result.item.revision, 1);
  assert.match(conflict.result.message, /revision/);
  assert.deepEqual(boardState(runtime), before);
});

test('evidence errors return the affected citation and allow correction from a fresh Read', async () => {
  const { invoke, react, runtime } = exploration();
  const file = await react.host.readFile('source.txt');
  const citation = {
    file_path: file.filePath, start_line: 1, end_line: 1,
    snippet: 'The original source.', content_hash: file.contentHash
  };
  const before = boardState(runtime);
  const fact = { status: 'confirmed', evidence: [citation] };
  assert.equal((await invoke('UpdateBoardItem', updateArgs(fact))).error.code, 'EVIDENCE_NOT_READ');
  assert.deepEqual(boardState(runtime), before);
  await invoke('Read', { file_path: 'source.txt', start_line: 1, end_line: 1 });
  const wrong = await invoke('UpdateBoardItem', updateArgs({
    ...fact, evidence: [{ ...citation, snippet: 'Paraphrased evidence.' }]
  }));
  assert.equal(wrong.error.code, 'EVIDENCE_SNIPPET_MISMATCH');
  assert.equal(wrong.error.details.index, 0);
  assert.equal(wrong.error.details.file_path, 'source.txt');
  assert.equal(wrong.error.details.source_preview, citation.snippet);
  assert.deepEqual(boardState(runtime), before);
  await react.host.writeFile('source.txt', 'Changed source.', { expectedHash: file.contentHash });
  assert.equal((await invoke('UpdateBoardItem', updateArgs(fact))).error.code, 'EVIDENCE_CHANGED');
  assert.deepEqual(boardState(runtime), before);
  const fresh = await invoke('Read', { file_path: 'source.txt' });
  const corrected = await invoke('UpdateBoardItem', updateArgs({
    status: 'contradicted', evidence: [{ ...citation,
      snippet: fresh.result.content, content_hash: fresh.result.contentHash
    }]
  }));
  assert.equal(corrected.ok, true);
  assert.equal(runtime.verification_requests[0].status, 'contradicted');
  assert.equal(runtime.fact_ledger[0].evidence[0].snippet, fresh.result.content);
});

test('Finish documents and enforces being the last call while retaining the empty payload', async () => {
  const spec = EXPLORATION_TOOLS.find(item => item.function.name === 'Finish').function;
  assert.match(spec.description, /本批次最后一个工具调用/);
  assert.deepEqual(spec.parameters.properties, {});
  assert.deepEqual(spec.parameters.required, []);
  const { react, invoke } = exploration();
  const results = await react.appendResults([call('Finish', {}), call('Glob', {})]);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error.message, /最后一个/);
  assert.equal(results[1].ok, true);
  assert.deepEqual((await invoke('Finish', {})).result, { status: 'complete' });
});

async function diskHost(t) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'varina-contract-'));
  t.after(async () => {
    // Verify the absolute cleanup target stays in the explicitly created temp directory.
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('varina-contract-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return new NodeFsHost(root).init();
}

for (const kind of ['memory', 'disk']) {
  const makeHost = async t => kind === 'disk' ? diskHost(t) : new MemoryHost();

  test(kind + ': Write rejects absent/null content and absent hash without changing files or backups', async t => {
    const host = await makeHost(t);
    await host.writeFile('file.txt', 'Keep this content.', { expectedHash: null });
    const original = await host.readFile('file.txt');
    const invoke = agent(host);
    for (const args of [
      { file_path: 'file.txt', expected_hash: original.contentHash },
      { file_path: 'file.txt', content: null, expected_hash: original.contentHash },
      { file_path: 'file.txt', content: 'Replacement.' },
      { file_path: 'new.txt', expected_hash: null },
      { file_path: 'new.txt', content: 'New content.' }
    ]) {
      const failed = await invoke('Write', args);
      assert.equal(failed.ok, false);
      assert.equal(failed.error.code, 'INVALID_ARGUMENT');
      assert.equal(failed.error.details.field, Object.hasOwn(args, 'content') && args.content !== null ? 'expected_hash' : 'content');
      assert.equal((await host.readFile('file.txt')).contentHash, original.contentHash);
      assert.deepEqual(await host.listBackups(), []);
      await assert.rejects(host.readFile('new.txt'), { code: 'ENOENT' });
    }
    // The host also protects callers that bypass the agent-level validation.
    await assert.rejects(host.writeFile('file.txt', undefined, { expectedHash: original.contentHash }), { code: 'INVALID_ARGUMENT' });
    assert.equal((await host.readFile('file.txt')).contentHash, original.contentHash);
    assert.deepEqual(await host.listBackups(), []);
    assert.deepEqual(AGENT_TOOL_SPECS.find(item => item.function.name === 'Write').function.parameters.required,
      ['file_path', 'content', 'expected_hash']);
  });

  test(kind + ': Write permits explicit empty content, backs up overwrites and rejects stale hashes', async t => {
    const host = await makeHost(t);
    const invoke = agent(host);
    assert.equal((await invoke('Write', { file_path: 'file.txt', content: 'Original.', expected_hash: null })).ok, true);
    const file = await host.readFile('file.txt');
    assert.equal((await invoke('Write', { file_path: 'file.txt', content: 'Bad overwrite.', expected_hash: null })).error.code, 'STALE_FILE');
    assert.equal((await invoke('Write', { file_path: 'file.txt', content: 'Bad overwrite.', expected_hash: 'stale' })).error.code, 'STALE_FILE');
    assert.deepEqual(await host.listBackups(), []);
    const cleared = await invoke('Write', { file_path: 'file.txt', content: '', expected_hash: file.contentHash });
    assert.equal(cleared.ok, true);
    assert.ok(cleared.result.backup.backup_id);
    assert.equal((await host.readFile('file.txt')).content, '');
    await host.restoreBackup(cleared.result.backup.backup_id);
    assert.equal((await host.readFile('file.txt')).content, 'Original.');
  });

  test(kind + ': Edit treats replacement tokens literally and supports deletion and whitespace', async t => {
    const host = await makeHost(t);
    const invoke = agent(host);
    await host.writeFile('edit.txt', 'before TARGET after', { expectedHash: null });
    const replacement = "$& $$ $` $' $1";
    const edit = async (old_string, new_string) => invoke('Edit', {
      file_path: 'edit.txt', old_string, new_string,
      expected_hash: (await host.readFile('edit.txt')).contentHash
    });
    const literal = await edit('TARGET', replacement);
    assert.equal(literal.ok, true);
    assert.equal((await host.readFile('edit.txt')).content, 'before ' + replacement + ' after');
    assert.equal((await edit(replacement, '')).ok, true);
    assert.equal((await host.readFile('edit.txt')).content, 'before  after');
    assert.equal((await edit('  ', '\t')).ok, true);
    assert.equal((await host.readFile('edit.txt')).content, 'before\tafter');
    assert.equal((await host.listBackups()).length, 3);
    const before = await host.readFile('edit.txt');
    const stale = await invoke('Edit', {
      file_path: 'edit.txt', old_string: 'before', new_string: 'unused', expected_hash: 'stale'
    });
    assert.equal(stale.error.code, 'STALE_FILE');
    assert.equal((await edit('', 'invalid')).error.code, 'INVALID_ARGUMENT');
    const duplicate = await edit('e', 'unused');
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error.message, /实际 3 次/);
    const absent = await edit('not present', 'unused');
    assert.equal(absent.ok, false);
    assert.match(absent.error.message, /实际 0 次/);
    assert.equal((await host.readFile('edit.txt')).contentHash, before.contentHash);
    assert.equal((await host.listBackups()).length, 3);
  });

  if (kind === 'disk') test('disk: Edit preserves UTF-8 BOM and CRLF', async t => {
    const host = await makeHost(t);
    const original = '\uFEFFFirst\r\nTARGET\r\nLast\r\n';
    await host.writeFile('bom.txt', original, { expectedHash: null });
    const file = await host.readFile('bom.txt');
    const edited = await agent(host)('Edit', {
      file_path: 'bom.txt', old_string: 'TARGET\nLast', new_string: 'Replacement\nLast', expected_hash: file.contentHash
    });
    assert.equal(edited.ok, true);
    assert.equal(await readFile(path.join(host.workspaceRoot, 'bom.txt'), 'utf8'), original.replace('TARGET', 'Replacement'));
  });

  test(kind + ': search skips excluded files and clips long matching lines with metadata', async t => {
    const host = await makeHost(t);
    for (const [name, content] of Object.entries({
      'src/One.MJS': 'Needle\n' + 'x'.repeat(600) + 'needle',
      'root.mjs': 'needle', '.secret.mjs': 'needle', '.hidden/secret.mjs': 'needle',
      'node_modules/lib.mjs': 'needle', 'dist/bundle.mjs': 'needle',
      'binary.mjs': 'needle\u0000binary', 'huge.mjs': 'needle' + 'x'.repeat(2 * 1024 * 1024)
    })) await host.writeFile(name, content, { expectedHash: null });
    const files = await host.listFiles('**/*.mjs');
    assert.ok(files.includes('src/One.MJS'));
    assert.ok(files.includes('root.mjs'));
    assert.equal(files.some(name => name.startsWith('.') || /^(node_modules|dist)\//.test(name)), false);
    const results = await agent(host)('Grep', { query: 'NEEDLE', path_filter: '**/*.mjs' });
    assert.equal(results.ok, true);
    assert.equal(results.result.length, 3);
    const clipped = results.result.find(item => item.line === 2);
    assert.equal(clipped.content.length, 500);
    assert.equal(clipped.line_chars, 606);
    assert.equal(clipped.truncated, true);
    assert.equal(results.result.some(item => ['binary.mjs', 'huge.mjs'].includes(item.file)), false);
    const regex = await agent(host)('Grep', { query: '^needle$', is_regex: true, path_filter: 'src/**/*.mjs' });
    assert.equal(regex.result.length, 1);
    assert.equal(regex.result[0].content, 'Needle');
  });
}

test('main and exploration searches report unsupported syntax and bounds instead of empty results or clamping', async () => {
  const host = new MemoryHost({ 'file.mjs': 'needle' });
  for (const invoke of [agent(host), exploration(host).invoke]) {
    for (const [name, args, code, field] of [
      ['Glob', { pattern: '{src,test}/**/*.mjs' }, 'UNSUPPORTED_GLOB', 'pattern'],
      ['Glob', { pattern: '**/[ab].mjs' }, 'UNSUPPORTED_GLOB', 'pattern'],
      ['Glob', { pattern: '**/*.@(mjs|js)' }, 'UNSUPPORTED_GLOB', 'pattern'],
      ['Glob', { pattern: '   ' }, 'INVALID_GLOB', 'pattern'],
      ['Glob', { max_results: 0 }, 'INVALID_MAX_RESULTS', 'max_results'],
      ['Glob', { max_results: 501 }, 'INVALID_MAX_RESULTS', 'max_results'],
      ['Grep', { query: 'needle', max_results: 501 }, 'INVALID_MAX_RESULTS', 'max_results'],
      ['Grep', { query: 'needle', path_filter: '{src,test}/**/*' }, 'UNSUPPORTED_GLOB', 'path_filter'],
      ['Grep', { query: 'a'.repeat(201), is_regex: true }, 'REGEX_TOO_LONG', 'query'],
      ['Grep', { query: 'a'.repeat(501) }, 'INVALID_QUERY', 'query'],
      ['Grep', { query: '(a)\\1', is_regex: true }, 'UNSUPPORTED_REGEX_BACKREFERENCE', 'query'],
      ['Grep', { query: '(a+)+', is_regex: true }, 'UNSAFE_REGEX', 'query'],
      ['Grep', { query: '.*.*', is_regex: true }, 'UNSAFE_REGEX', 'query'],
      ['Grep', { query: '[', is_regex: true }, 'INVALID_REGEX', 'query']
    ]) {
      const failed = await invoke(name, args);
      assert.equal(failed.ok, false, name + ': ' + JSON.stringify(args));
      assert.equal(failed.error.code, code);
      assert.equal(failed.error.details.field, field);
      assert.ok(failed.error.message.length > 0);
    }
    assert.deepEqual((await invoke('Glob', { pattern: '**/*.mjs', max_results: 500 })).result, ['file.mjs']);
    assert.equal((await invoke('Grep', { query: 'needle', max_results: 1 })).result.length, 1);
  }
});
