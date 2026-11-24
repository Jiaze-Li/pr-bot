// Provider-level tests for DeepSeek and Gemini: multi-turn tool calling, thinking mode, structured output, usage and
// error classification. No network and no real model: fetch is scripted, the tool gateway is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_SCHEMA } from '../scripts/review.mjs';
import { ReadOnlyToolGateway } from '../scripts/tool-gateway.mjs';
import { runDeepSeek, deepseekBaseUrl, schemaInstruction } from '../scripts/deepseek-provider.mjs';
import { runGemini, toGeminiJsonSchema, geminiBaseUrl } from '../scripts/gemini-provider.mjs';
import { validateResult } from '../scripts/provider-common.mjs';

const VALID = {
  summary: 'One file reviewed; the retry path is correct.',
  findings: [],
  prior_findings: [],
  coverage: { complete: true, reviewedPaths: ['src/a.js'], unreviewedPaths: [], note: '' },
};

function gateway() {
  const calls = [];
  return {
    calls,
    history: [],
    getToolDeclarations: () => ReadOnlyToolGateway.getToolDeclarations(),
    runExclusive: (fn) => fn(),
    async executeTool(name, input) {
      calls.push({ name, input });
      return { ok: true, content: `[lines=3]\n1: content of ${input.file_path ?? input.pattern}` };
    },
  };
}

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// Every request is recorded, then answered by the next scripted step.
function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra provider request');
    return typeof step === 'function' ? step(body, calls) : step;
  };
  fn.calls = calls;
  return fn;
}

const deepseekReply = ({ content = '', toolCalls = null, reasoning = null, usage = {}, finish = null, model = 'deepseek-flash' }) => response({
  model,
  choices: [{
    finish_reason: finish ?? (toolCalls ? 'tool_calls' : 'stop'),
    message: {
      role: 'assistant', content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
  }],
  usage,
});

const env = { DEEPSEEK_API_KEY: 'ds-key' };

// ---------------------------------------------------------------- DeepSeek

test('DeepSeek: multi-turn tool calling with thinking mode echoes reasoning_content and passes real tool results', async () => {
  const gw = gateway();
  const fetchImpl = scriptedFetch([
    deepseekReply({
      reasoning: 'I need the file first.',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"src/a.js"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } },
    }),
    deepseekReply({ content: JSON.stringify(VALID), usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } }),
  ]);

  const outcome = await runDeepSeek({ prompt: 'review this', schema: RESULT_SCHEMA, toolGateway: gw, env, fetchImpl, maxTurns: 14 });

  assert.equal(outcome.ok, true, outcome.error);
  assert.deepEqual(outcome.structured, VALID);
  assert.deepEqual(gw.calls, [{ name: 'Read', input: { file_path: 'src/a.js' } }], 'the tool runs through the host gateway');

  const first = fetchImpl.calls[0];
  assert.equal(first.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(first.headers.Authorization, 'Bearer ds-key');
  assert.deepEqual(first.body.thinking, { type: 'enabled' }, 'thinking mode is on by default');
  assert.equal(first.body.reasoning_effort, 'high');
  assert.equal(first.body.tools.length, 3, 'only the gateway tools are declared');
  assert.deepEqual(first.body.tools.map((t) => t.function.name).sort(), ['Glob', 'Grep', 'Read']);
  assert.ok(first.body.messages[0].content.includes('JSON Schema'), 'the schema is stated for json_object output');

  const second = fetchImpl.calls[1].body.messages;
  assert.equal(second.at(-2).role, 'assistant');
  assert.equal(second.at(-2).reasoning_content, 'I need the file first.', 'reasoning_content must be echoed back with tools present');
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'call_1');
  assert.match(second.at(-1).content, /content of src\/a\.js/);

  assert.equal(outcome.meta.provider, 'deepseek');
  assert.equal(outcome.meta.num_turns, 2);
  assert.equal(outcome.meta.tool_calls, 1);
  assert.equal(outcome.meta.input_tokens, 300);
  assert.equal(outcome.meta.output_tokens, 70);
  assert.equal(outcome.meta.cache_read_input_tokens, 40);
  assert.equal(outcome.meta.thoughts_tokens, 12);
  assert.equal(outcome.meta.cost_usd_nominal, null, 'without configured prices the cost is unknown, not zero');
  assert.equal(outcome.meta.cost_source, 'unknown');
});

test('DeepSeek: a prose answer is followed by one json_object request without tools, and the result is schema-validated', async () => {
  const fetchImpl = scriptedFetch([
    deepseekReply({ content: 'I looked at the change and it seems fine.', reasoning: 'reasoning text' }),
    deepseekReply({ content: JSON.stringify(VALID) }),
  ]);
  const outcome = await runDeepSeek({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env, fetchImpl });
  assert.equal(outcome.ok, true, outcome.error);
  const final = fetchImpl.calls[1].body;
  assert.deepEqual(final.response_format, { type: 'json_object' });
  assert.equal(final.tools, undefined, 'the structured turn carries no tools');
  assert.equal(final.messages.some((m) => m.reasoning_content), false, 'reasoning_content is not echoed without tools');
  assert.match(final.messages.at(-1).content, /final review/);
});

test('DeepSeek: output that does not match the review schema is a malformed failure, never credited', async () => {
  const fetchImpl = scriptedFetch([
    deepseekReply({ content: '{"summary":"x","findings":[],"prior_findings":[],"coverage":{"complete":true}}' }),
    deepseekReply({ content: '{"summary":"x"}' }),
  ]);
  const outcome = await runDeepSeek({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env, fetchImpl });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorKind, 'malformed');
  assert.match(outcome.error, /schema/);
});

test('DeepSeek: HTTP errors are classified and never retried inside the provider', async () => {
  for (const [status, kind] of [[401, 'config'], [404, 'config'], [402, 'unavailable'], [429, 'unavailable'], [503, 'unavailable'], [400, 'execution']]) {
    const fetchImpl = scriptedFetch([response('nope', status)]);
    const outcome = await runDeepSeek({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env, fetchImpl });
    assert.equal(outcome.ok, false, `HTTP ${status}`);
    assert.equal(outcome.errorKind, kind, `HTTP ${status}`);
    assert.equal(fetchImpl.calls.length, 1, `HTTP ${status} must not be retried internally`);
    assert.equal(outcome.meta.provider, 'deepseek');
  }
});

test('DeepSeek: a missing key or an unsafe base URL fails before any request', async () => {
  const noKey = scriptedFetch([]);
  const a = await runDeepSeek({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env: {}, fetchImpl: noKey });
  assert.equal(a.errorKind, 'config');
  assert.match(a.error, /DEEPSEEK_API_KEY/);
  assert.equal(noKey.calls.length, 0);

  const insecure = scriptedFetch([]);
  const b = await runDeepSeek({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: 'http://api.deepseek.com' }, fetchImpl: insecure });
  assert.equal(b.errorKind, 'config');
  assert.equal(insecure.calls.length, 0);
});

test('DeepSeek: the base URL, model and effort are configuration, so the endpoint can move later', async () => {
  const fetchImpl = scriptedFetch([deepseekReply({ content: JSON.stringify(VALID) })]);
  const outcome = await runDeepSeek({
    prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), fetchImpl,
    env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: 'https://opencode.example/api/', DEEPSEEK_MODEL: 'other-model', DEEPSEEK_REASONING_EFFORT: 'max' },
  });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(fetchImpl.calls[0].url, 'https://opencode.example/api/chat/completions');
  assert.equal(fetchImpl.calls[0].body.model, 'other-model');
  assert.equal(fetchImpl.calls[0].body.reasoning_effort, 'max');
  assert.equal(deepseekBaseUrl({}), 'https://api.deepseek.com');
});

test('DeepSeek: configured prices turn usage into a nominal cost estimate', async () => {
  const fetchImpl = scriptedFetch([deepseekReply({
    content: JSON.stringify(VALID),
    usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000, prompt_cache_hit_tokens: 0 },
  })]);
  const outcome = await runDeepSeek({
    prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), fetchImpl,
    env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_INPUT_PRICE_PER_MTOK: '0.28', DEEPSEEK_OUTPUT_PRICE_PER_MTOK: '0.42' },
  });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.meta.cost_source, 'configured-prices');
  assert.equal(Math.round(outcome.meta.cost_usd_nominal * 1000) / 1000, 0.49);
});

test('DeepSeek: the turn budget, a timeout and unknown tools are execution failures, not silent successes', async () => {
  const loop = Array.from({ length: 2 }, () => deepseekReply({
    toolCalls: [{ id: 'c', type: 'function', function: { name: 'Glob', arguments: '{"pattern":"**/*.js"}' } }],
  }));
  const turns = await runDeepSeek({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env, fetchImpl: scriptedFetch(loop), maxTurns: 2 });
  assert.equal(turns.errorKind, 'turns');
  assert.equal(turns.meta.num_turns, 2);

  const timedOut = await runDeepSeek({
    prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env,
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
  });
  assert.equal(timedOut.errorKind, 'timeout');

  const gw = gateway();
  const fetchImpl = scriptedFetch([
    deepseekReply({ toolCalls: [{ id: 'c', type: 'function', function: { name: 'Bash', arguments: '{"command":"rm -rf /"}' } }] }),
    deepseekReply({ content: JSON.stringify(VALID) }),
  ]);
  const unknown = await runDeepSeek({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gw, env, fetchImpl });
  assert.equal(unknown.ok, true);
  assert.equal(gw.calls.length, 0, 'an undeclared tool never reaches the gateway');
  assert.match(fetchImpl.calls[1].body.messages.at(-1).content, /not available/);
});

test('DeepSeek: invalid tool arguments are reported back to the model instead of crashing', async () => {
  const gw = gateway();
  const fetchImpl = scriptedFetch([
    deepseekReply({ toolCalls: [{ id: 'c', type: 'function', function: { name: 'Read', arguments: '{"file_path":' } }] }),
    deepseekReply({ content: JSON.stringify(VALID) }),
  ]);
  const outcome = await runDeepSeek({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gw, env, fetchImpl });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(gw.calls.length, 0);
  assert.match(fetchImpl.calls[1].body.messages.at(-1).content, /not valid JSON/);
});

// ---------------------------------------------------------------- Gemini

const geminiReply = ({ parts, usage = {}, finish = 'STOP', model = 'gemini-flash-latest' }) => response({
  modelVersion: model,
  candidates: [{ finishReason: finish, content: { parts } }],
  usageMetadata: usage,
});

const geminiEnv = { GEMINI_API_KEY: 'g-key' };

test('Gemini: functionCall turns are executed through the gateway and the model parts (with signatures) are preserved', async () => {
  const gw = gateway();
  const fetchImpl = scriptedFetch([
    geminiReply({
      parts: [{ text: 'Let me search.' }, { thoughtSignature: 'sig-1' }, { functionCall: { name: 'Grep', args: { pattern: 'retry' } } }],
      usage: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 30, totalTokenCount: 140 },
    }),
    geminiReply({ parts: [{ text: JSON.stringify(VALID) }], usage: { promptTokenCount: 150, candidatesTokenCount: 40, totalTokenCount: 190 } }),
  ]);
  const outcome = await runGemini({ prompt: 'review this', schema: RESULT_SCHEMA, toolGateway: gw, env: geminiEnv, fetchImpl });

  assert.equal(outcome.ok, true, outcome.error);
  assert.deepEqual(outcome.structured, VALID);
  assert.deepEqual(gw.calls, [{ name: 'Grep', input: { pattern: 'retry' } }]);
  const first = fetchImpl.calls[0];
  assert.equal(first.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
  assert.equal(first.headers['x-goog-api-key'], 'g-key');
  assert.equal(first.body.tools[0].functionDeclarations.length, 3);
  assert.equal(first.body.tools[0].functionDeclarations.find((d) => d.name === 'Read').parameters.properties.file_path.minLength, undefined, 'unsupported JSON Schema keys are stripped');
  assert.equal(first.body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  assert.equal(first.body.contents[0].parts[0].text, 'review this');

  const contents = fetchImpl.calls[1].body.contents;
  assert.deepEqual(contents[1].parts.find((p) => p.thoughtSignature)?.thoughtSignature, 'sig-1', 'thought signatures go back verbatim');
  assert.equal(contents[2].role, 'user');
  assert.equal(contents[2].parts[0].functionResponse.name, 'Grep');
  assert.match(contents[2].parts[0].functionResponse.response.output, /content of retry/);

  assert.equal(outcome.meta.provider, 'gemini');
  assert.equal(outcome.meta.num_turns, 2);
  assert.equal(outcome.meta.tool_calls, 1);
  assert.equal(outcome.meta.input_tokens, 250);
  assert.equal(outcome.meta.output_tokens, 50);
  assert.equal(outcome.meta.thoughts_tokens, 30);
});

test('Gemini: a non-JSON answer is followed by one schema-constrained request without tools', async () => {
  const fetchImpl = scriptedFetch([
    geminiReply({ parts: [{ text: 'Nothing suspicious.' }] }),
    geminiReply({ parts: [{ text: JSON.stringify(VALID) }] }),
  ]);
  const outcome = await runGemini({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env: geminiEnv, fetchImpl });
  assert.equal(outcome.ok, true, outcome.error);
  const final = fetchImpl.calls[1].body;
  assert.equal(final.tools, undefined);
  assert.equal(final.generationConfig.responseMimeType, 'application/json');
  assert.equal(final.generationConfig.responseSchema.required.includes('coverage'), true);
  assert.equal(final.generationConfig.responseSchema.properties.coverage.properties.complete.type, 'boolean');
});

test('Gemini: schema-invalid, empty and truncated structured results are malformed failures', async () => {
  for (const reply of [
    geminiReply({ parts: [{ text: '{"summary":"only this"}' }] }),
    geminiReply({ parts: [{ text: '' }] }),
    geminiReply({ parts: [{ text: '{"summary":"x"}' }], finish: 'MAX_TOKENS' }),
  ]) {
    const fetchImpl = scriptedFetch([reply, reply]);
    const outcome = await runGemini({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env: geminiEnv, fetchImpl });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorKind, 'malformed');
  }
});

test('Gemini: HTTP errors are classified, and the API key is never sent to a non-Google host', async () => {
  for (const [status, kind] of [[403, 'config'], [404, 'config'], [429, 'unavailable'], [500, 'unavailable']]) {
    const fetchImpl = scriptedFetch([response('no', status)]);
    const outcome = await runGemini({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env: geminiEnv, fetchImpl });
    assert.equal(outcome.errorKind, kind, `HTTP ${status}`);
    assert.equal(fetchImpl.calls.length, 1);
  }
  const missing = await runGemini({ prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), env: {}, fetchImpl: scriptedFetch([]) });
  assert.equal(missing.errorKind, 'config');
  assert.equal(geminiBaseUrl({}), 'https://generativelanguage.googleapis.com');
  assert.throws(() => geminiBaseUrl({ GEMINI_API_BASE_URL: 'https://evil.example' }), /must be/);
  assert.equal(geminiBaseUrl({ GEMINI_API_BASE_URL: 'http://127.0.0.1:8080' }), 'http://127.0.0.1:8080');
});

test('Gemini: usage and configured prices are reported as a nominal estimate', async () => {
  const fetchImpl = scriptedFetch([geminiReply({
    parts: [{ text: JSON.stringify(VALID) }],
    usage: { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 400_000, totalTokenCount: 1_500_000 },
  })]);
  const outcome = await runGemini({
    prompt: 'p', schema: RESULT_SCHEMA, toolGateway: gateway(), fetchImpl,
    env: { GEMINI_API_KEY: 'k', GEMINI_INPUT_PRICE_PER_MTOK: '0.30', GEMINI_OUTPUT_PRICE_PER_MTOK: '2.50' },
  });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.meta.cost_source, 'configured-prices');
  // 1.0M input * 0.30 + (0.1M output + 0.4M thoughts) * 2.50 = 0.30 + 1.25
  assert.equal(Math.round(outcome.meta.cost_usd_nominal * 1000) / 1000, 1.55);
});

// ---------------------------------------------------------------- shared validation

test('the shared validator enforces the review schema the Claude SDK would have enforced', () => {
  assert.equal(validateResult(VALID, RESULT_SCHEMA).ok, true);
  assert.equal(validateResult({ ...VALID, extra: 1 }, RESULT_SCHEMA).ok, false, 'additionalProperties:false');
  assert.equal(validateResult({ ...VALID, findings: [{ severity: 'P9', title: 't', path: 'a', failure_path: '' }] }, RESULT_SCHEMA).ok, false, 'enum');
  assert.equal(validateResult({ ...VALID, coverage: { ...VALID.coverage, complete: 'yes' } }, RESULT_SCHEMA).ok, false, 'boolean');
  assert.equal(validateResult({ summary: '', findings: [], prior_findings: [], coverage: VALID.coverage }, RESULT_SCHEMA).ok, false, 'minLength');
});

test('schema instructions are generated from the real schema', () => {
  assert.match(schemaInstruction(RESULT_SCHEMA), /JSON only|Return ONLY one JSON object/);
  assert.match(schemaInstruction(RESULT_SCHEMA), /"prior_findings"/);
  const gemini = toGeminiJsonSchema(RESULT_SCHEMA);
  assert.equal(gemini.properties.summary.minLength, undefined);
  assert.equal(gemini.properties.findings.maxItems, 20);
  assert.equal(gemini.properties.coverage.properties.reviewedPaths.items.type, 'string');
});
