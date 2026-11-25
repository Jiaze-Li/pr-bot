// Real-API verification, opt-in. It is skipped unless RUN_LIVE_PROVIDER_TESTS=1 AND the provider credential is
// present, so CI never spends money by accident. When it is skipped the reason is printed, never a fake pass.
//
// Isolation: a fresh temporary repository snapshot, a real read-only tool gateway, no GitHub token in the provider
// environment, and a prompt that can only be answered by reading a file through the gateway (tool calling) before
// returning the review schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESULT_SCHEMA, buildPrompt } from '../scripts/review.mjs';
import { ReadOnlyToolGateway } from '../scripts/tool-gateway.mjs';
import { runDeepSeek } from '../scripts/deepseek-provider.mjs';
import { runGemini } from '../scripts/gemini-provider.mjs';
import { validateResult } from '../scripts/provider-common.mjs';

const NONCE = 'ZQ7-LIVE-TOOL-CHECK';
const enabled = process.env.RUN_LIVE_PROVIDER_TESTS === '1';

function sandbox() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-live-')));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/answer.txt'), `${NONCE}\n`);
  const gw = new ReadOnlyToolGateway({ safeRoot: root, contextRoot: null, maxCalls: 12 });
  const prompt = `Read src/answer.txt with the Read tool. Put the exact token it contains in "summary", return no findings,
and report coverage.complete=true with reviewedPaths ["src/answer.txt"]. Do not guess the token.`;
  return { gw, prompt };
}

const liveEnv = (keys) => Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));

async function liveRun({ name, credential, keys, prompt: customPrompt, run }) {
  if (!enabled) return { skip: 'RUN_LIVE_PROVIDER_TESTS is not 1: real API verification not requested' };
  if (!process.env[credential]) return { skip: `${credential} is not set: real ${name} API verification cannot run` };
  const { gw, prompt } = sandbox();
  const outcome = await run({ prompt: customPrompt ?? prompt, gw, env: liveEnv(keys) });
  return { outcome, gw };
}

test('live DeepSeek: tool calling + thinking + structured output against the real API', async (t) => {
  const { skip, outcome, gw } = await liveRun({
    name: 'DeepSeek',
    credential: 'DEEPSEEK_API_KEY',
    keys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_REASONING_EFFORT'],
    run: ({ prompt, gw: gateway, env }) => runDeepSeek({ prompt, schema: RESULT_SCHEMA, toolGateway: gateway, env, maxTurns: 2, timeoutMs: 120_000 }),
  });
  if (skip) return t.skip(skip);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.meta.provider, 'deepseek');
  assert.equal(outcome.meta.final_effort, process.env.DEEPSEEK_REASONING_EFFORT === 'none' ? 'none' : 'low');
  assert.equal(outcome.meta.num_turns, 2, 'one tool turn and the reserved final turn');
  assert.ok(outcome.meta.input_tokens > 0 && outcome.meta.output_tokens > 0, 'the API reported token usage');
  assert.ok(outcome.meta.duration_ms > 0);
  assert.equal(validateResult(outcome.structured, RESULT_SCHEMA).ok, true);
  assert.ok(gw.history.some((entry) => entry.toolName === 'Read' && entry.status === 'success'),
    `the model must have used the Read tool; summary was ${JSON.stringify(outcome.structured.summary).slice(0, 120)}`);
  assert.match(outcome.structured.summary, new RegExp(NONCE), 'the summary proves the file content was really read');
});

test('live Gemini: tool calling + structured output against the real API', async (t) => {
  const { skip, outcome, gw } = await liveRun({
    name: 'Gemini',
    credential: 'GEMINI_API_KEY',
    keys: ['GEMINI_API_KEY', 'GEMINI_API_BASE_URL', 'GEMINI_MODEL', 'GEMINI_THINKING_LEVEL'],
    // One exploration turn forces the final responseJsonSchema request immediately after a tool response.
    run: ({ prompt, gw: gateway, env }) => runGemini({ prompt, schema: RESULT_SCHEMA, toolGateway: gateway, env, maxTurns: 2, timeoutMs: 120_000 }),
  });
  if (skip) return t.skip(skip);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.meta.provider, 'gemini');
  assert.equal(outcome.meta.used_response_json_schema, true, 'must execute the final responseJsonSchema request');
  assert.equal(outcome.meta.num_turns, 2, 'one tool turn and the reserved final turn');
  assert.ok(outcome.meta.input_tokens > 0 && outcome.meta.output_tokens > 0, 'the API reported token usage');
  assert.equal(validateResult(outcome.structured, RESULT_SCHEMA).ok, true);
  assert.ok(gw.history.some((entry) => entry.toolName === 'Read' && entry.status === 'success'),
    `the model must have used the Read tool; summary was ${JSON.stringify(outcome.structured.summary).slice(0, 120)}`);
  assert.match(outcome.structured.summary, new RegExp(NONCE), 'the summary proves the file content was really read');
});


// Deterministically inject one deliberately overlong model reply; the repair itself uses the real API.
// This exercises the exact production recovery path without depending on a model accidentally violating the schema.
const SENTENCE = 'When CACHE_MISS is true, the handler skips persisting the record, so RECORD_LOST occurs.';
const overlong = {
  summary: 'One illustrative finding.',
  findings: [{ severity: 'P2', title: 'Missing persistence', path: 'src/answer.txt', failure_path: (SENTENCE + ' ').repeat(10) }],
  prior_findings: [],
  coverage: { complete: true, reviewedPaths: ['src/answer.txt'], unreviewedPaths: [], note: '' },
};
for (const [name, credential, keys, run, synthetic] of [
  ['DeepSeek', 'DEEPSEEK_API_KEY', ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_REASONING_EFFORT'], runDeepSeek,
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(overlong), reasoning_content: 'Synthetic format-repair test input.' } }] }],
  ['Gemini', 'GEMINI_API_KEY', ['GEMINI_API_KEY', 'GEMINI_API_BASE_URL', 'GEMINI_MODEL', 'GEMINI_THINKING_LEVEL'], runGemini,
    { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(overlong) }] } }] }],
]) {
  test(`live ${name}: repair an injected overlong result using the real API`, async (t) => {
    if (!enabled) return t.skip('RUN_LIVE_PROVIDER_TESTS is not 1');
    if (!process.env[credential]) return t.skip(`${credential} is not set`);
    const { gw } = sandbox();
    let requests = 0;
    const outcome = await run({
      prompt: 'A synthetic review result follows. Preserve its findings and coverage. If asked to shorten its evidence, keep the exact trigger CACHE_MISS and consequence RECORD_LOST.',
      schema: RESULT_SCHEMA, toolGateway: gw, env: liveEnv(keys), maxTurns: 3, timeoutMs: 120_000,
      fetchImpl: async (url, init) => ++requests === 1
        ? new Response(JSON.stringify(synthetic), { status: 200 })
        : fetch(url, init),
    });
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.meta.format_repair, true);
    assert.equal(outcome.meta.num_turns, 2);
    assert.equal(requests, 2);
    assert.equal(outcome.meta.tool_calls, 0);
    assert.ok(outcome.meta.output_tokens > 0, 'real repair returned token usage');
    assert.equal(validateResult(outcome.structured, RESULT_SCHEMA).ok, true);
    assert.equal(outcome.structured.findings.length, 1);
    assert.equal(outcome.structured.findings[0].severity, 'P2');
    assert.equal(outcome.structured.findings[0].path, 'src/answer.txt');
    assert.deepEqual(outcome.structured.coverage, overlong.coverage);
    assert.match(outcome.structured.findings[0].failure_path, /CACHE_MISS/);
    assert.match(outcome.structured.findings[0].failure_path, /RECORD_LOST/);
  });
}


// Reduced synthetic reproductions of SpinLab #235 F002 and #234 F014/F025 using the actual shared prompt.
// No application repository contents, GitHub credentials or actual PR attempts. This is a smoke regression, not
// a statistical comparison of model quality.
test('live DeepSeek: recognize a fixed control-flow bug, retain a true ownership bug, and accept a valid primary key', async (t) => {
  if (!enabled) return t.skip('RUN_LIVE_PROVIDER_TESTS is not 1');
  if (!process.env.DEEPSEEK_API_KEY) return t.skip('DEEPSEEK_API_KEY is not set');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-cases-')));
  try {
    const sources = {
      "reminder.js": "export function notify(s, current) {\n  if (s.fingerprint !== current) {\n    if (s.windowOpen) { s.pending = true; return; }\n    else { s.alert = true; }\n  }\n  s.fingerprint = current;\n}\nexport function close(s, current) {\n  s.windowOpen = false;\n  if (s.pending) { s.pending = false; notify(s, current); }\n}",
      "ingest.js": "export function ingest(committed, operationID, confirmedSampleUID) {\n  if (committed.has(operationID)) return committed.get(operationID);\n  const result = { sampleUID: confirmedSampleUID };\n  committed.set(operationID, result);\n  return result;\n}",
      "ownership.sql": "CREATE TABLE sample_asset_links (asset_id TEXT PRIMARY KEY NOT NULL, sample_uid TEXT NOT NULL);",
      "ownership.test.js": "import { DatabaseSync } from 'node:sqlite';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nconst db = new DatabaseSync(':memory:');\ndb.exec(readFileSync(new URL('./ownership.sql', import.meta.url), 'utf8'));\ndb.exec(\"INSERT INTO sample_asset_links VALUES ('source-a', 'sample-a')\");\nassert.throws(() => db.exec(\"INSERT INTO sample_asset_links VALUES ('source-a', 'sample-b')\"), /UNIQUE constraint failed/);\ndb.close();"
    };
    for (const [file, content] of Object.entries(sources)) fs.writeFileSync(path.join(root, file), content + '\n');
    const assigned = Object.keys(sources);
    const diffText = Object.entries(sources).map(([file, content]) => {
      const lines = content.split('\n');
      if (file === 'reminder.js') {
        return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${lines.length} +1,${lines.length} @@\n` +
          lines.map(line => line.includes('s.pending = true; return;') ? '-    if (s.windowOpen) { s.pending = true; }\n+' + line : ' ' + line).join('\n');
      }
      return `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}`;
    }).join('\n');
    const prior = [{ id: 'F001', severity: 'P2', path: 'reminder.js', title: 'Deferred reminder lost', failure_path: 'When the window is open, notify sets pending and immediately persists the new fingerprint; quitting before close then loses the reminder.' }];
    const prompt = buildPrompt({ repo: 'fixture/review-cases', prNumber: 1, head: 'a'.repeat(40), round: 2,
      pr: { title: 'Fix deferred reminder and enforce ownership', body: 'A changed fingerprint must not be persisted while its reminder is deferred. Persisted fingerprint is restored on restart and notify is called. Ingest uses a map of committed operations; retrying the same operation for the same sample is idempotent, but a replay for a different confirmed sample must reject. The ownership table is intentionally a relation-only fixture; its sole tested constraint is at most one sample owner for a source asset ID. Assume valid nonempty source and sample IDs and a single writer. No further schema or UI is in scope.' },
      assigned, diffText, needsRead: new Map(), otherFiles: [], pendingBlockers: prior, batchNo: 1, maxTurns: 8 });
    const gw = new ReadOnlyToolGateway({ safeRoot: root, contextRoot: null, maxCalls: 32 });
    const result = await runDeepSeek({ prompt, schema: RESULT_SCHEMA, toolGateway: gw, env: liveEnv(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_REASONING_EFFORT']), maxTurns: 8, timeoutMs: 120_000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.structured.coverage.complete, true);
    assert.deepEqual([...result.structured.coverage.reviewedPaths].sort(), [...assigned].sort());
    const verdict = result.structured.prior_findings.find(f => f.id === 'F001');
    assert.equal(verdict?.verification, 'FIXED', JSON.stringify(result.structured));
    assert.ok(verdict.evidence.trim());
    const blocking = result.structured.findings.filter(f => f.severity !== 'P3');
    assert.ok(blocking.some(f => f.path === 'ingest.js'), 'must still detect true cross-sample replay defect: ' + JSON.stringify(blocking));
    assert.ok(blocking.every(f => f.path === 'ingest.js'), 'must not block fixed reminder or valid primary key: ' + JSON.stringify(blocking));
    console.log('case replay verdicts: ' + JSON.stringify({ fixed: verdict.id, blocking: blocking.map(f => ({ path: f.path, severity: f.severity })), turns: result.meta.num_turns, final_effort: result.meta.final_effort, thoughts_tokens: result.meta.thoughts_tokens }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live DeepSeek: recover an injected truncated final result through the real API', async (t) => {
  if (!enabled) return t.skip('RUN_LIVE_PROVIDER_TESTS is not 1');
  if (!process.env.DEEPSEEK_API_KEY) return t.skip('DEEPSEEK_API_KEY is not set');
  const { gw, prompt } = sandbox();
  let requests = 0;
  const result = await runDeepSeek({
    prompt, schema: RESULT_SCHEMA, toolGateway: gw,
    env: liveEnv(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_REASONING_EFFORT']),
    maxTurns: 3, timeoutMs: 120_000,
    fetchImpl: async (url, init) => {
      if (++requests === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: 'Read the requested file.', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'Read', arguments: '{"file_path":"src/answer.txt"}' } }] } }] }), { status: 200 });
      if (requests === 2) return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"summary":"', reasoning_content: 'The tool result contains the requested token; no findings.' } }] }), { status: 200 });
      return fetch(url, init);
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.meta.truncation_recovery, true);
  assert.equal(result.meta.format_repair, false);
  assert.equal(result.meta.num_turns, 3);
  assert.equal(requests, 3);
  assert.equal(result.meta.tool_calls, 1);
  assert.ok(result.meta.output_tokens > 0);
  assert.match(result.structured.summary, new RegExp(NONCE));
  assert.deepEqual(result.structured.findings, []);
  assert.equal(result.structured.coverage.complete, true);
  assert.deepEqual(result.structured.coverage.reviewedPaths, ['src/answer.txt']);
});
