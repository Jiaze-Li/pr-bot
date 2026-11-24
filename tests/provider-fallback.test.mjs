// Fallback behaviour, end to end through the real executor: only execution failure switches provider, every
// execution (primary or fallback) is one attempt in the same 30-execution budget, and the prompt/tools/schema are
// identical. Uses injected runners so no network or real model is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOT_LOGIN, MAX_ATTEMPTS, renderComment } from '../scripts/review-contract.mjs';
import { makeScope } from '../scripts/review-engine.mjs';
import { createProvider, runReview } from '../scripts/review.mjs';
import { resolveProviderConfig, providerCredentialProblem } from '../scripts/model-provider.mjs';
import { MERGE_BASE, PR, REPO, assignedFrom, fakeGithub, makeContext, model, sha } from './helpers/harness.mjs';

const files = (n) => Array.from({ length: n }, (_, i) => `src/f${String(i).padStart(2, '0')}.js`);
const stateOf = (gh) => gh.state_().state;
const P2 = { severity: 'P2', title: 'Retry drops chunk', path: 'src/f00.js', failure_path: 'Second attempt skips the final chunk so the file is truncated.' };

function safeRoot() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-fallback-')));
}

// -> { gh, result, logs, primaryCalls, fallbackCalls }
async function run({ changed = files(1), primary, fallback = null, env = {}, seed = null }) {
  const gh = fakeGithub();
  if (seed) gh.comments.push({ id: '99', source: 'issue', type: 'Bot', login: BOT_LOGIN, body: renderComment(seed) });
  const primaryCalls = [];
  const fallbackCalls = [];
  const logs = [];
  const provider = await createProvider({
    env: { REVIEW_PROVIDER: 'deepseek', REVIEW_FALLBACK_PROVIDER: fallback ? 'gemini' : '', SAFE_REPO_DIR: safeRoot(), ...env },
    runModel: async (args) => {
      const call = { assigned: assignedFrom(args.prompt), prompt: args.prompt, fallback: args.fallback, args };
      primaryCalls.push(call);
      return primary(call, primaryCalls.length);
    },
    runFallbackModel: fallback
      ? async (args) => {
        const call = { assigned: assignedFrom(args.prompt), prompt: args.prompt, fallback: args.fallback, args };
        fallbackCalls.push(call);
        return fallback(call, fallbackCalls.length);
      }
      : null,
  });
  const result = await runReview({
    env: { TARGET_REPO: REPO, PR_NUMBER: String(PR), HEAD_SHA: gh.head, ...env }, github: gh, provider,
    loadCtx: makeContext(changed), now: () => Date.now(), log: (line) => logs.push(line),
  });
  return { gh, result, logs, primaryCalls, fallbackCalls };
}

const diagnostics = (logs) => logs.filter((l) => l.startsWith('REVIEW_DIAGNOSTICS ')).map((l) => JSON.parse(l.slice('REVIEW_DIAGNOSTICS '.length)));

test('an execution failure switches to the fallback with the SAME prompt, and both executions are counted as attempts', async () => {
  const { gh, result, primaryCalls, fallbackCalls } = await run({
    changed: files(2),
    primary: () => model.fail('primary provider is down'),
    fallback: (call) => model.ok({ assigned: call.assigned }),
  });
  assert.equal(result.status, 'READY');
  assert.equal(primaryCalls.length, 1);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(primaryCalls[0].prompt, fallbackCalls[0].prompt, 'the fallback reviews the identical batch and prompt');
  assert.equal(primaryCalls[0].fallback, false);
  assert.equal(fallbackCalls[0].fallback, true);
  assert.equal(stateOf(gh).attempts_used, 2, 'the failed primary and the fallback are two spent executions');
  assert.equal(stateOf(gh).completed_rounds, 1);
});

test('the diagnostics record which provider and model actually ran, and mark the fallback execution', async () => {
  const { logs } = await run({
    primary: (call) => ({ ...model.fail('boom'), meta: { provider: 'deepseek', requested_model: 'deepseek-flash', input_tokens: 10, output_tokens: 2 } }),
    fallback: (call) => ({ ...model.ok({ assigned: call.assigned }), meta: { provider: 'gemini', resolved_model: 'gemini-flash-latest', input_tokens: 20, output_tokens: 3, cost_source: 'configured-prices', cost_usd_nominal: 0.01 } }),
  });
  const rows = diagnostics(logs);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.provider, r.fallback, r.ok]), [['deepseek', false, false], ['gemini', true, true]]);
  assert.equal(rows[0].model, 'deepseek-flash');
  assert.equal(rows[1].model, 'gemini-flash-latest');
  assert.equal(rows[1].input_tokens, 20);
  assert.equal(rows[1].cost_usd_nominal, 0.01);
  assert.match(rows[1].cost_note, /configured per-Mtok prices/);
});

test('a produced review is never re-rolled: findings, an empty result or an uncredited coverage claim stay on the primary', async () => {
  const withFinding = await run({ primary: (call) => model.ok({ assigned: call.assigned, findings: [P2] }), fallback: (call) => model.ok({ assigned: call.assigned }) });
  assert.equal(withFinding.result.status, 'CHANGES_REQUESTED');
  assert.equal(withFinding.fallbackCalls.length, 0, 'a blocking finding is a review result, not an execution failure');

  const empty = await run({ primary: (call) => model.ok({ assigned: call.assigned, findings: [], reviewed: call.assigned }), fallback: (call) => model.ok({ assigned: call.assigned }) });
  assert.equal(empty.result.status, 'READY');
  assert.equal(empty.fallbackCalls.length, 0, 'a clean result is not retried on another model');

  // The model returned a well-formed document but credited nothing: that is a weak review, not an execution failure.
  const uncredited = await run({
    changed: files(2),
    primary: (call, n) => (n === 1 ? model.ok({ assigned: call.assigned, reviewed: [], unreviewed: call.assigned, complete: false }) : model.ok({ assigned: call.assigned })),
    fallback: (call) => model.ok({ assigned: call.assigned }),
  });
  assert.equal(uncredited.result.status, 'READY');
  assert.equal(uncredited.fallbackCalls.length, 0);
  assert.equal(uncredited.primaryCalls.length, 2);
});

test('a failing fallback is also spent and cannot exceed the 30-execution lifetime budget', async () => {
  // 28 attempts already spent: the primary becomes attempt 29, the fallback attempt 30, and that is the end.
  const changed = files(1);
  const seed = {
    schema_version: 2, repo: REPO, pr_number: PR, head_sha: sha('a'), status: 'STOPPED',
    reason: 'Interrupted earlier; request a review again to continue.', completed_rounds: 0, completed_head_sha: null,
    attempts_used: MAX_ATTEMPTS - 2, stalled_attempts: 0, scope: makeScope({ mergeBase: MERGE_BASE, files: changed }),
    reviewed_files: [], findings: [], updated_at: '2026-11-24T00:00:00.000Z',
  };
  const { gh, result, primaryCalls, fallbackCalls } = await run({
    changed,
    seed,
    primary: () => model.fail('primary down'),
    fallback: () => model.fail('fallback down'),
  });
  assert.equal(primaryCalls.length, 1);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(stateOf(gh).attempts_used, MAX_ATTEMPTS, 'the budget is exactly used, never exceeded');
  assert.equal(result.status, 'STOPPED');
  assert.match(stateOf(gh).reason, /Model execution budget used up/);
});

test('the fallback fits inside the budget when it is the last allowed execution, and succeeds there', async () => {
  const changed = files(1);
  const seed = {
    schema_version: 2, repo: REPO, pr_number: PR, head_sha: sha('a'), status: 'STOPPED',
    reason: 'Interrupted earlier; request a review again to continue.', completed_rounds: 0, completed_head_sha: null,
    attempts_used: MAX_ATTEMPTS - 2, stalled_attempts: 0, scope: makeScope({ mergeBase: MERGE_BASE, files: changed }),
    reviewed_files: [], findings: [], updated_at: '2026-11-24T00:00:00.000Z',
  };
  const { gh, result, fallbackCalls } = await run({
    changed,
    seed,
    primary: () => model.fail('primary down'),
    fallback: (call) => model.ok({ assigned: call.assigned }),
  });
  assert.equal(fallbackCalls.length, 1);
  assert.equal(result.status, 'READY');
  assert.equal(stateOf(gh).attempts_used, MAX_ATTEMPTS);
});

test('the per-run attempt limit also covers fallback executions', async () => {
  // 31 files are four batches; each batch costs two executions (failed primary + fallback). After three credited
  // batches the run has used six executions, so the fourth batch is not started even though progress was made.
  const { result, primaryCalls, fallbackCalls, gh } = await run({
    changed: files(31),
    primary: () => model.fail('primary down'),
    fallback: (call) => model.ok({ assigned: call.assigned }),
  });
  assert.equal(primaryCalls.length + fallbackCalls.length, 6, 'six executions per run, primary and fallback together');
  assert.equal(primaryCalls.length, 3);
  assert.equal(fallbackCalls.length, 3);
  assert.equal(result.status, 'STOPPED');
  assert.match(stateOf(gh).reason, /This run used its 6 attempts/);
  assert.equal(stateOf(gh).attempts_used, 6);
});

test('without a configured fallback a failure just spends the attempt, exactly as before', async () => {
  const { gh, result, primaryCalls, fallbackCalls } = await run({
    changed: files(2),
    primary: (call, n) => (n === 1 ? model.fail('down') : model.ok({ assigned: call.assigned })),
  });
  assert.equal(fallbackCalls.length, 0);
  assert.equal(primaryCalls.length, 2);
  assert.equal(result.status, 'READY');
  assert.equal(stateOf(gh).attempts_used, 2);
});

test('a missing credential for the configured provider stops before any attempt is spent', async () => {
  const root = safeRoot();
  const provider = await createProvider({ env: { REVIEW_PROVIDER: 'deepseek', REVIEW_FALLBACK_PROVIDER: 'gemini', SAFE_REPO_DIR: root } });
  assert.throws(() => provider.preflight(), /deepseek review provider: DEEPSEEK_API_KEY is not configured/);

  const both = await createProvider({ env: { REVIEW_PROVIDER: 'claude', REVIEW_FALLBACK_PROVIDER: 'gemini', CLAUDE_CODE_OAUTH_TOKEN: 'x', SAFE_REPO_DIR: root } });
  assert.throws(() => both.preflight(), /gemini review provider: GEMINI_API_KEY is not configured/);
});

test('provider configuration defaults to Claude with no fallback and rejects unknown names', () => {
  assert.deepEqual(resolveProviderConfig({}), { primary: { name: 'claude', model: 'sonnet' }, fallback: null });
  assert.deepEqual(
    resolveProviderConfig({ REVIEW_PROVIDER: 'deepseek', REVIEW_FALLBACK_PROVIDER: 'gemini', DEEPSEEK_MODEL: 'deepseek-flash' }),
    { primary: { name: 'deepseek', model: 'deepseek-flash' }, fallback: { name: 'gemini', model: 'gemini-flash-latest' } },
  );
  assert.equal(resolveProviderConfig({ REVIEW_PROVIDER: 'deepseek', REVIEW_FALLBACK_PROVIDER: 'deepseek' }).fallback, null, 'the same provider is not a fallback');
  assert.throws(() => resolveProviderConfig({ REVIEW_PROVIDER: 'gpt' }), /REVIEW_PROVIDER/);
  assert.throws(() => resolveProviderConfig({ REVIEW_PROVIDER: 'deepseek', REVIEW_FALLBACK_PROVIDER: 'gpt' }), /REVIEW_FALLBACK_PROVIDER/);
  assert.match(providerCredentialProblem('claude', {}), /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(providerCredentialProblem('gemini', { GEMINI_API_KEY: 'k' }), null);
});

test('failed primary and failed fallback each increment consecutiveFailures and stalled_attempts', async () => {
  const { gh, result, primaryCalls, fallbackCalls } = await run({
    changed: files(2),
    primary: () => model.fail('primary down'),
    fallback: () => model.fail('fallback down'),
  });
  assert.equal(result.status, 'STOPPED');
  assert.equal(primaryCalls.length, 1);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(stateOf(gh).attempts_used, 2);
  assert.equal(stateOf(gh).stalled_attempts, 2);
  assert.match(stateOf(gh).reason, /2 consecutive attempts made no progress/);

  const changed = files(2);
  const seed = {
    schema_version: 2, repo: REPO, pr_number: PR, head_sha: sha('a'), status: 'STOPPED',
    reason: '2 consecutive attempts made no progress', completed_rounds: 0, completed_head_sha: null,
    attempts_used: 2, stalled_attempts: 2, scope: makeScope({ mergeBase: MERGE_BASE, files: changed }),
    reviewed_files: [], findings: [], updated_at: '2026-11-24T00:00:00.000Z',
  };
  const second = await run({
    changed,
    seed,
    primary: () => model.fail('primary down'),
    fallback: () => model.fail('fallback down'),
  });
  assert.equal(second.result.status, 'STOPPED');
  assert.equal(stateOf(second.gh).attempts_used, 4);
  assert.equal(stateOf(second.gh).stalled_attempts, 4);
  assert.match(stateOf(second.gh).reason, /No further automatic attempt for this HEAD/);
});
