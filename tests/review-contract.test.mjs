import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BOT_LOGIN, MARKER, MAX_ATTEMPTS, evaluateComment, parseComment, readState, renderComment, validateState,
} from '../scripts/review-contract.mjs';
import { FIXTURES_PATH, buildFixtures, checkFixtures } from '../scripts/review-fixtures.mjs';
import { applyBatch, claimAttempt, concludeRound, makeScope, parseBatchOutput } from '../scripts/review-engine.mjs';

const REPO = 'owner/repo';
const sha = (c) => c.repeat(40);
const scope = makeScope({ mergeBase: sha('0'), files: ['a.js', 'b.js'] });
const base = () => claimAttempt({ prev: null, repo: REPO, prNumber: 5, head: sha('a'), scope, now: Date.UTC(2026, 10, 21) });
const rec = (body, over = {}) => ({ id: '1', source: 'issue', login: BOT_LOGIN, type: 'Bot', body, ...over });

test('the committed fixtures are exactly what the real code generates, and the consumer-side evaluation agrees', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')), JSON.parse(JSON.stringify(buildFixtures())), 'run: npm run review:fixtures');
  assert.deepEqual(checkFixtures(JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'))), []);
});

test('render/parse round-trips and the JSON block alone carries the state', () => {
  const state = base();
  const body = renderComment(state);
  assert.ok(body.startsWith(MARKER));
  assert.deepEqual(parseComment(body).value, state);
  assert.equal(readState([rec(body)], { repo: REPO, prNumber: 5 }).kind, 'ok');
});

test('historical P3 is displayed as NOT_RECHECKED on the next HEAD without altering the authoritative result', () => {
  const suggestion = { severity: 'P3', title: 'Missing roadmap PR number', path: 'a.js', failure_path: 'The roadmap omits the PR number.' };
  const output = (findings) => parseBatchOutput({ summary: 's', findings, prior_findings: [], coverage: { complete: true, reviewedPaths: ['a.js', 'b.js'], unreviewedPaths: [], note: '' } }).value;
  const finish = (state, findings) => concludeRound(applyBatch({ state, assigned: ['a.js', 'b.js'], output: output(findings), needsRead: new Map(), reads: new Map(), now: 1 }).state, 1);
  const first = finish(base(), [suggestion]);
  assert.match(renderComment(first), /\| F001 \| P3 \| OPEN \|/);
  assert.doesNotMatch(renderComment(first), /NOT_RECHECKED/);
  const next = claimAttempt({ prev: first, repo: REPO, prNumber: 5, head: sha('b'), scope, now: 2 });
  const done = finish(next, []);
  assert.equal(done.status, 'READY');
  assert.equal(done.completed_rounds, 2);
  assert.equal(done.findings[0].verification, 'OPEN');
  assert.equal(done.findings[0].checked_head_sha, sha('a'));
  const body = renderComment(done);
  assert.match(body, /\| F001 \| P3 \| NOT_RECHECKED \|/);
  assert.match(body, /neither confirmed open nor confirmed fixed/);
  assert.deepEqual(parseComment(body).value, done);
  assert.ok(validateState(done).ok);
  assert.equal(evaluateComment({ repo: REPO, prNumber: 5, localHead: sha('b'), currentHead: sha('b'), authorLogin: BOT_LOGIN, authorType: 'Bot', body }).decision, 'READY');
});

test('NOT_RECHECKED is a table-only projection for P3 with missing or stale HEAD evidence', () => {
  const state = base();
  const finding = { title: 't', path: 'a.js', failure_path: 'x', severity: 'P3' };
  const rows = [
    ['P3', 'OPEN', null, 'NOT_RECHECKED'],
    ['P3', 'FIXED', sha('b'), 'NOT_RECHECKED'],
    ['P3', 'STILL_OPEN', sha('b'), 'NOT_RECHECKED'],
    ['P3', 'UNCERTAIN', sha('b'), 'NOT_RECHECKED'],
    ['P3', 'OPEN', sha('a'), 'OPEN'],
    ['P3', 'FIXED', sha('a'), 'FIXED'],
    ['P3', 'STILL_OPEN', sha('a'), 'STILL_OPEN'],
    ['P3', 'UNCERTAIN', sha('a'), 'UNCERTAIN'],
    ['P2', 'OPEN', sha('b'), 'OPEN'],
    ['P1', 'UNCERTAIN', sha('b'), 'UNCERTAIN'],
    ['P0', 'STILL_OPEN', sha('b'), 'STILL_OPEN'],
  ];
  state.findings = rows.map(([severity, verification, checked_head_sha], i) => ({ ...finding, id: `F${String(i + 1).padStart(3, '0')}`, severity, verification, checked_head_sha }));
  const body = renderComment(state);
  rows.forEach(([severity, , , display], i) => {
    assert.ok(body.includes(`| ${state.findings[i].id} | ${severity} | ${display} |`));
  });
  assert.deepEqual(parseComment(body).value, state);
});

test('only the bot author counts; two state comments conflict; v1 and corrupt documents are never trusted', () => {
  const body = renderComment({ ...base() });
  const opts = { repo: REPO, prNumber: 5 };
  assert.equal(readState([rec(body, { login: 'mallory', type: 'User' })], opts).kind, 'none');
  assert.equal(readState([rec(body, { type: 'User' })], opts).kind, 'none');
  assert.equal(readState([rec(body), rec(body, { id: '2' })], opts).kind, 'conflict');
  assert.equal(readState([rec(body, { id: '1' }), rec(body, { id: '2', login: 'mallory', type: 'User' })], opts).kind, 'ok');
  assert.equal(readState([rec(`${MARKER}\n\`\`\`json\n{"schema_version":2\n\`\`\`\n`)], opts).kind, 'invalid');
  assert.equal(readState([rec(body)], { repo: 'other/repo', prNumber: 5 }).kind, 'invalid');
  assert.equal(readState([rec(body)], { repo: REPO, prNumber: 6 }).kind, 'invalid');
  assert.equal(readState([rec(`${MARKER}\n\`\`\`json\n{"schema_version":1}\n\`\`\`\n`)], opts).kind, 'legacy');
});

test('contradictory states are invalid: READY with a blocker, READY off the concluded HEAD, CHANGES_REQUESTED without one', () => {
  const finding = { id: 'F001', severity: 'P2', title: 't', path: 'a.js', failure_path: 'x', verification: 'OPEN', checked_head_sha: sha('a') };
  const done = concludeRound(applyBatch({ state: base(), assigned: ['a.js', 'b.js'], output: parseBatchOutput({ summary: 's', findings: [], prior_findings: [], coverage: { complete: true, reviewedPaths: ['a.js', 'b.js'], unreviewedPaths: [], note: '' } }).value, now: 1 }).state, 1);
  assert.equal(done.status, 'READY');
  assert.ok(validateState(done).ok);
  assert.ok(!validateState({ ...done, findings: [finding] }).ok);
  assert.ok(!validateState({ ...done, completed_head_sha: sha('b') }).ok);
  assert.ok(!validateState({ ...done, status: 'CHANGES_REQUESTED' }).ok);
  assert.ok(validateState({ ...done, completed_rounds: 3 }).ok, 'third round READY is valid');
  assert.ok(!validateState({ ...done, completed_rounds: 4 }).ok);
  assert.ok(validateState({ ...done, status: 'CHANGES_REQUESTED', completed_rounds: 2, findings: [finding] }).ok, 'round two may request another fix');
  assert.ok(!validateState({ ...done, status: 'CHANGES_REQUESTED', completed_rounds: 3, findings: [finding] }).ok, 'the third round is final');
  assert.ok(validateState({ ...done, attempts_used: MAX_ATTEMPTS }).ok);
  assert.ok(!validateState({ ...done, attempts_used: MAX_ATTEMPTS + 1 }).ok);
  assert.ok(!validateState({ ...done, completed_rounds: 0 }).ok);
});

test('evaluateComment: stale HEAD, forged author, in-progress and missing are WAIT; a trusted conclusion on the exact HEAD is its status', () => {
  const state = base();
  const body = renderComment(state);
  const args = { repo: REPO, prNumber: 5, localHead: sha('a'), currentHead: sha('a'), authorLogin: BOT_LOGIN, authorType: 'Bot', body };
  assert.equal(evaluateComment(args).decision, 'WAIT'); // IN_PROGRESS
  assert.equal(evaluateComment({ ...args, body: '' }).decision, 'WAIT');
  assert.equal(evaluateComment({ ...args, authorType: 'User' }).trusted, false);
  assert.equal(evaluateComment({ ...args, currentHead: sha('b') }).decision, 'WAIT');
});

test('the rendered comment stays under the GitHub limit with a full set of findings; the JSON is never the part that is dropped', () => {
  const state = base();
  state.findings = Array.from({ length: 40 }, (_, i) => ({ id: `F${String(i + 1).padStart(3, '0')}`, severity: 'P2', title: 't'.repeat(200), path: `src/${'p'.repeat(100)}${i}.js`, failure_path: 'f'.repeat(600), verification: 'OPEN', checked_head_sha: sha('a') }));
  const body = renderComment(state);
  assert.ok(body.length < 65536);
  assert.equal(parseComment(body).value.findings.length, 40);
});
