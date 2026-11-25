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
import { RESULT_SCHEMA } from '../scripts/review.mjs';
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
    run: ({ prompt, gw: gateway, env }) => runDeepSeek({ prompt, schema: RESULT_SCHEMA, toolGateway: gateway, env, maxTurns: 4, timeoutMs: 120_000 }),
  });
  if (skip) return t.skip(skip);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.meta.provider, 'deepseek');
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
    // Force a plain-prose reply first so runGemini must exercise the final responseJsonSchema request.
    prompt: `Read src/answer.txt with the Read tool. After reading it, reply in one short plain-text sentence (do NOT output JSON) stating the exact token it contains.`,
    run: ({ prompt, gw: gateway, env }) => runGemini({ prompt, schema: RESULT_SCHEMA, toolGateway: gateway, env, maxTurns: 5, timeoutMs: 120_000 }),
  });
  if (skip) return t.skip(skip);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.meta.provider, 'gemini');
  assert.ok(outcome.meta.num_turns >= 3, `expected tool turn + prose turn + final responseJsonSchema turn, got ${outcome.meta.num_turns}`);
  assert.ok(outcome.meta.input_tokens > 0 && outcome.meta.output_tokens > 0, 'the API reported token usage');
  assert.equal(validateResult(outcome.structured, RESULT_SCHEMA).ok, true);
  assert.ok(gw.history.some((entry) => entry.toolName === 'Read' && entry.status === 'success'),
    `the model must have used the Read tool; summary was ${JSON.stringify(outcome.structured.summary).slice(0, 120)}`);
  assert.match(outcome.structured.summary, new RegExp(NONCE), 'the summary proves the file content was really read');
});
