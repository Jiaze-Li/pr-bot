import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT_LOGIN, MAX_ATTEMPTS, MAX_ROUNDS, isBlocking, renderComment } from '../scripts/review-contract.mjs';
import { makeScope } from '../scripts/review-engine.mjs';
import { MERGE_BASE, PR, REPO, assignedFrom, fakeGithub, makeContext, model, review, scriptedProvider, sha } from './helpers/harness.mjs';

const files = (n) => Array.from({ length: n }, (_, i) => `src/f${String(i).padStart(2, '0')}.js`);
const P2 = { severity: 'P2', title: 'Retry drops chunk', path: 'src/f00.js', failure_path: 'Second attempt skips the final chunk so the file is truncated.' };
const all = (call) => model.ok({ assigned: call.assigned });
const stateOf = (gh) => gh.state_().state;

test('#219 scale: 26 files are covered in sequential batches, one round is counted, and a P2 found early is not published early', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(files(26));
  const provider = scriptedProvider((call) => (call.n === 1
    ? model.ok({ assigned: call.assigned, findings: [P2], reviewed: call.assigned.slice(0, 6), unreviewed: call.assigned.slice(6), complete: false })
    : all(call)));
  const result = await review({ gh, provider, ctx });
  const s = stateOf(gh);
  assert.equal(result.status, 'CHANGES_REQUESTED');
  assert.equal(s.completed_rounds, 1);
  assert.equal(s.attempts_used, provider.calls.length);
  assert.ok(provider.calls.every((c) => c.assigned.length <= 10), 'batches are bounded by file count');
  assert.equal(new Set(provider.calls.flatMap((c) => c.assigned)).size, 26);
  assert.ok(s.findings.some((f) => f.id === 'F001' && f.path === 'src/f00.js'), 'the early finding survives');
  const written = gh.writtenStates();
  const firstConclusion = written.findIndex((w) => w.status === 'CHANGES_REQUESTED');
  assert.ok(written.slice(0, firstConclusion).every((w) => w.status === 'IN_PROGRESS' && w.completed_rounds === 0), 'no CHANGES_REQUESTED before coverage is complete');
  assert.equal(written.filter((w) => w.completed_rounds === 1).length, 1, 'the round is counted in exactly one write');
  assert.equal(gh.statuses.at(-1).state, 'failure');
});

test('a batch is bounded by diff size as well as file count', async () => {
  const gh = fakeGithub();
  const names = files(6);
  const provider = scriptedProvider((call) => model.ok({ assigned: call.assigned, readPaths: call.assigned }));
  await review({ gh, provider, ctx: makeContext(names, { bigDiff: names }) });
  assert.ok(provider.calls.every((c) => c.assigned.length === 1), `complete 60KB diffs exceed the 70KB batch target together, got ${provider.calls.map((c) => c.assigned.length)}`);
  assert.equal(stateOf(gh).completed_rounds, 1);
});

test('a same-HEAD technical failure keeps the spent attempt, adds no round, and a rerun resumes the remaining files', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(files(14));
  const crash = scriptedProvider((call) => (call.n === 1 ? model.ok({ assigned: call.assigned }) : model.fail('boom')));
  const first = await review({ gh, provider: crash, ctx });
  let s = stateOf(gh);
  assert.equal(first.status, 'STOPPED');
  assert.equal(s.completed_rounds, 0);
  assert.equal(s.attempts_used, crash.calls.length);
  assert.equal(s.reviewed_files.length, 10, 'the first batch stays credited');
  const spent = s.attempts_used;
  const resume = scriptedProvider(all);
  const second = await review({ gh, provider: resume, ctx });
  s = stateOf(gh);
  assert.equal(second.status, 'READY');
  assert.ok(resume.calls.flatMap((c) => c.assigned).every((f) => files(14).slice(10).includes(f)));
  assert.equal(s.completed_rounds, 1);
  assert.equal(s.attempts_used, spent + resume.calls.length);
});

test('a crash after the attempt was recorded leaves it spent; a stale IN_PROGRESS is recovered, a fresh one is waited for', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(files(3));
  const dies = scriptedProvider(() => { throw new Error('runner killed'); });
  await review({ gh, provider: dies, ctx, env: {} });
  assert.equal(stateOf(gh).completed_rounds, 0);
  assert.ok(stateOf(gh).attempts_used >= 1);
  // simulate a hard kill: the comment is left IN_PROGRESS
  const s = stateOf(gh);
  const t0 = Date.parse(s.updated_at);
  const midRun = { ...s, status: 'IN_PROGRESS', claimed_at: new Date(t0).toISOString() };
  const { renderComment } = await import('../scripts/review-contract.mjs');
  gh.comments[0].body = renderComment(midRun);
  const fresh = scriptedProvider(all);
  const waited = await review({ gh, provider: fresh, ctx, now: () => t0 + 60_000 });
  assert.equal(waited.action, 'wait_in_progress');
  assert.equal(fresh.calls.length, 0);
  const recovered = await review({ gh, provider: fresh, ctx, now: () => t0 + 60 * 60_000 });
  assert.equal(recovered.status, 'READY');
  assert.equal(stateOf(gh).attempts_used, midRun.attempts_used + fresh.calls.length);
});

test('a complete result is reused: no model call, no new round; repeated events change nothing', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(files(4));
  await review({ gh, provider: scriptedProvider(all), ctx });
  const before = JSON.stringify(stateOf(gh));
  const writes = gh.writes.length;
  for (let i = 0; i < 3; i += 1) {
    const provider = scriptedProvider(all);
    const r = await review({ gh, provider, ctx });
    assert.equal(r.action, 'reuse');
    assert.equal(provider.calls.length, 0);
  }
  assert.equal(JSON.stringify(stateOf(gh)), before);
  assert.equal(gh.writes.length, writes);
});

test('a lost PATCH response is verified by re-reading, never repeated: the round is counted once', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(files(2));
  const provider = scriptedProvider(all);
  // lose the response of the FINAL write (the one that carries the conclusion)
  const patch = gh.patchComment.bind(gh);
  gh.patchComment = async (id, body) => {
    await patch(id, body);
    if (JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)[1]).status === 'READY') throw new Error('network reset after the write landed');
  };
  const r = await review({ gh, provider, ctx });
  assert.equal(r.status, 'READY');
  assert.equal(stateOf(gh).completed_rounds, 1);
  assert.equal(provider.calls.length, 1);
});

test('another writer changing the state comment stops the run without overwriting it', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(files(14));
  const provider = scriptedProvider((call) => {
    gh.comments[0].body = gh.comments[0].body.replace('"stalled_attempts": 0', '"stalled_attempts": 3'); // someone else edits the comment mid-run
    return all(call);
  });
  await assert.rejects(review({ gh, provider, ctx }), /changed by another writer/);
  assert.equal(provider.calls.length, 1, 'no second model call after the conflict');
});

test('a transient PATCH failure retries only if the authoritative state is still unchanged', async () => {
  const gh = fakeGithub();
  const patch = gh.patchComment.bind(gh);
  let patches = 0;
  gh.patchComment = async (id, body) => {
    patches += 1;
    if (patches === 1) throw new Error('HTTP 502 before the PATCH was applied');
    return patch(id, body);
  };
  const result = await review({ gh, provider: scriptedProvider(all), ctx: makeContext(files(2)) });
  assert.equal(result.status, 'READY');
  assert.equal(patches, 2);
  assert.equal(stateOf(gh).completed_rounds, 1);
  assert.equal(stateOf(gh).attempts_used, 1);
});

test('a failed PATCH followed by another writer is never retried over their new state', async () => {
  const gh = fakeGithub();
  let patches = 0;
  gh.patchComment = async () => {
    patches += 1;
    if (patches === 1) {
      // Simulate a concurrent writer after the first PATCH request fails, before retry.
      gh.comments[0].body = gh.comments[0].body.replace('"stalled_attempts": 0', '"stalled_attempts": 3');
      throw new Error('HTTP 502; meanwhile another writer updated the state');
    }
    throw new Error('MUST NOT WRITE: stale retry would overwrite another writer');
  };
  await assert.rejects(
    review({ gh, provider: scriptedProvider(all), ctx: makeContext(files(2)) }),
    /changed by another writer/,
  );
  assert.equal(patches, 1, 'no second PATCH may overwrite the other writer');
  assert.equal(gh.writes.length, 1, 'the only successful write is the initial attempt claim');
  assert.match(gh.comments[0].body, /"stalled_attempts": 3/);
});

test('round 2 unresolved blocker requests changes; round 3 is final and a fourth is forbidden', async () => {
  const gh = fakeGithub({ head: sha('a') });
  const ctx = makeContext(files(3));
  await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: [P2] })), ctx });
  assert.equal(stateOf(gh).status, 'CHANGES_REQUESTED');
  assert.equal(stateOf(gh).completed_rounds, 1);

  gh.head = sha('b');
  const r2 = await review({ gh, provider: scriptedProvider(all), ctx });
  let s = stateOf(gh);
  assert.equal(r2.status, 'CHANGES_REQUESTED');
  assert.equal(s.completed_rounds, 2);
  assert.equal(s.findings.find((f) => f.id === 'F001').verification, 'UNCERTAIN', 'omission is not a fix');
  assert.ok(s.findings.some(isBlocking));

  gh.head = sha('c');
  const r3 = await review({ gh, provider: scriptedProvider(all), ctx });
  s = stateOf(gh);
  assert.equal(r3.status, 'STOPPED');
  assert.equal(s.completed_rounds, MAX_ROUNDS);
  assert.ok(s.findings.some(isBlocking));

  gh.head = sha('d'); // another push must not start a fourth complete round
  const none = scriptedProvider(all);
  const r4 = await review({ gh, provider: none, ctx });
  assert.equal(r4.action, 'budget_stop');
  assert.equal(none.calls.length, 0);
  s = stateOf(gh);
  assert.equal(s.status, 'STOPPED');
  assert.equal(s.completed_rounds, MAX_ROUNDS);
  assert.equal(s.head_sha, sha('d'));
});

test('round 2 with FIXED + evidence reaches READY; FIXED without evidence does not', async () => {
  for (const [evidence, expected] of [['loop now flushes the last chunk (src/f00.js:12)', 'READY'], ['', 'CHANGES_REQUESTED']]) {
    const gh = fakeGithub({ head: sha('a') });
    const ctx = makeContext(files(2));
    await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: [P2] })), ctx });
    gh.head = sha('b');
    const r = await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, prior: [{ id: 'F001', verification: 'FIXED', evidence }] })), ctx });
    assert.equal(r.status, expected);
  }
});


test('#234 F009: uncertain early verdict remains in the later batch and can be corrected on the same HEAD', async () => {
  const gh = fakeGithub({ head: sha('a') });
  const doc = 'docs/brief.md';
  const ctx = makeContext([...files(10), doc]);
  const finding = { ...P2, path: doc, title: 'Conflicting task authorization', failure_path: 'The old contract prohibits the implementation requested by 5C.' };
  await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: c.n === 1 ? [finding] : [] })), ctx });
  assert.equal(stateOf(gh).status, 'CHANGES_REQUESTED');
  gh.head = sha('b');
  const provider = scriptedProvider((c) => {
    assert.match(c.prompt, /F001.*old contract/);
    return model.ok({ assigned: c.assigned, prior: [{ id: 'F001', verification: c.n === 1 ? 'UNCERTAIN' : 'FIXED', evidence: c.n === 1 ? '' : 'docs/brief.md:3 now explicitly authorizes code.' }] });
  });
  await review({ gh, provider, ctx });
  assert.equal(provider.calls.length, 2);
  assert.equal(stateOf(gh).status, 'READY');
  assert.equal(stateOf(gh).findings[0].verification, 'FIXED');
});

test('same-HEAD definitive evidence wins over uncertainty, but positive failure evidence cannot be erased', async () => {
  for (const [first, second, expected] of [
    ['FIXED', 'UNCERTAIN', 'FIXED'],
    ['UNCERTAIN', 'FIXED', 'FIXED'],
    ['UNCERTAIN', 'STILL_OPEN', 'STILL_OPEN'],
    ['STILL_OPEN', 'UNCERTAIN', 'STILL_OPEN'],
    ['FIXED', 'STILL_OPEN', 'STILL_OPEN'],
    ['STILL_OPEN', 'FIXED', 'STILL_OPEN'],
  ]) {
    const gh = fakeGithub({ head: sha('a') });
    const ctx = makeContext(files(11));
    await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: c.n === 1 ? [P2] : [] })), ctx });
    gh.head = sha('b');
    const provider = scriptedProvider((c) => model.ok({ assigned: c.assigned, prior: [{ id: 'F001', verification: c.n === 1 ? first : second, evidence: 'Current concrete code evidence.' }] }));
    await review({ gh, provider, ctx });
    assert.equal(stateOf(gh).findings[0].verification, expected, `${first} then ${second}`);
    assert.equal(stateOf(gh).status, expected === 'FIXED' ? 'READY' : 'CHANGES_REQUESTED');
  }
  const gh = fakeGithub();
  const ctx = makeContext(files(11));
  await review({ gh, ctx, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: c.n === 1 ? [P2] : [], prior: c.n === 2 ? [{ id: 'F001', verification: 'FIXED', evidence: 'contradictory same-HEAD claim' }] : [] })) });
  assert.equal(stateOf(gh).status, 'CHANGES_REQUESTED', 'new positive failure cannot be cleared on unchanged HEAD');
});


test('a bare STILL_OPEN claim cannot override FIXED evidence or manufacture a definitive verdict', async () => {
  for (const [first, second, expected] of [
    [{ verification: 'FIXED', evidence: 'The current early return prevents persistence.' }, { verification: 'STILL_OPEN', evidence: '' }, 'FIXED'],
    [{ verification: 'STILL_OPEN', evidence: '' }, { verification: 'FIXED', evidence: 'The current early return prevents persistence.' }, 'FIXED'],
    [{ verification: 'STILL_OPEN', evidence: ' ' }, { verification: 'UNCERTAIN', evidence: '' }, 'UNCERTAIN'],
  ]) {
    const gh = fakeGithub({ head: sha('a') });
    const ctx = makeContext(files(11));
    await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: c.n === 1 ? [P2] : [] })), ctx });
    gh.head = sha('b');
    await review({ gh, ctx, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, prior: [{ id: 'F001', ...(c.n === 1 ? first : second) }] })) });
    assert.equal(stateOf(gh).findings[0].verification, expected);
    assert.equal(stateOf(gh).status, expected === 'FIXED' ? 'READY' : 'CHANGES_REQUESTED');
  }
});

test('later batches see earlier finding identities including P3; the shared prompt demands current evidence', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(files(11));
  const suggestion = { ...P2, severity: 'P3', title: 'One useful suggestion' };
  const provider = scriptedProvider((c) => {
    if (c.n === 2) {
      assert.match(c.prompt, /F001 \[P3\/OPEN\].*One useful suggestion/);
      assert.match(c.prompt, /exactly its existing path and title/);
      assert.match(c.prompt, /verify that the alleged caller actually calls that code/);
      assert.match(c.prompt, /Do not demand a redundant mechanism/);
    }
    return model.ok({ assigned: c.assigned, findings: c.n === 1 ? [suggestion] : [] });
  });
  await review({ gh, provider, ctx });
  assert.equal(stateOf(gh).status, 'READY');
  assert.equal(stateOf(gh).findings.length, 1);
});

test('a repeated report of an old FIXED or P3 issue is not hidden by the old verdict', async () => {
  const gh = fakeGithub({ head: sha('a') });
  const ctx = makeContext(files(2));
  await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: [{ ...P2, severity: 'P3', failure_path: '' }] })), ctx });
  assert.equal(stateOf(gh).status, 'READY');
  gh.head = sha('b'); // round 2: the same title now comes back as P2
  await review({ gh, provider: scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: [P2] })), ctx });
  const s = stateOf(gh);
  assert.equal(s.status, 'CHANGES_REQUESTED');
  assert.equal(s.findings.length, 1, 'same issue keeps its id');
  assert.equal(s.findings[0].severity, 'P2');
});

test('HEAD moving during an attempt: the attempt stays spent, nothing is credited, and the new HEAD is not passed', async () => {
  const gh = fakeGithub({ head: sha('a') });
  const ctx = makeContext(files(3));
  const moved = scriptedProvider((call) => { gh.head = sha('b'); return all(call); });
  const r = await review({ gh, provider: moved, ctx, env: { HEAD_SHA: sha('a') } });
  let s = stateOf(gh);
  assert.equal(r.status, 'STOPPED');
  assert.equal(s.completed_rounds, 0);
  assert.equal(s.attempts_used, 1);
  assert.equal(s.head_sha, sha('a'));
  assert.deepEqual(s.reviewed_files, []);
  // the queued event for the new HEAD continues; the spent attempt stays on the books
  const next = scriptedProvider(all);
  await review({ gh, provider: next, ctx, env: { HEAD_SHA: sha('b') } });
  s = stateOf(gh);
  assert.equal(s.status, 'READY');
  assert.equal(s.head_sha, sha('b'));
  assert.equal(s.attempts_used, 1 + next.calls.length);
});

test('unfinished work + new HEAD: old coverage is dropped, attempts kept, the earlier blocker must be re-verified; READY + edit starts round 2', async () => {
  const gh = fakeGithub({ head: sha('a') });
  const ctx = makeContext(files(14));
  const p1 = scriptedProvider((c) => (c.n === 1 ? model.ok({ assigned: c.assigned, findings: [P2] }) : model.fail()));
  await review({ gh, provider: p1, ctx });
  let s = stateOf(gh);
  const spent = s.attempts_used;
  assert.equal(s.reviewed_files.length, 10);

  gh.head = sha('b');
  const p2 = scriptedProvider((c) => model.ok({ assigned: c.assigned }));
  await review({ gh, provider: p2, ctx });
  s = stateOf(gh);
  assert.equal(p2.calls[0].assigned.length, 10, 'coverage restarted from zero on the new HEAD');
  assert.match(p2.calls[0].prompt, /Earlier blocking findings/, 'the earlier blocker is carried for verification');
  assert.equal(s.attempts_used, spent + p2.calls.length);
  assert.equal(s.completed_rounds, 1, 'still the same logical round');
  assert.equal(s.findings[0].verification, 'UNCERTAIN');
  assert.equal(s.status, 'CHANGES_REQUESTED');

  // READY, then an edit: second round on the new HEAD
  const gh2 = fakeGithub({ head: sha('a') });
  await review({ gh: gh2, provider: scriptedProvider(all), ctx: makeContext(files(2)) });
  assert.equal(stateOf(gh2).status, 'READY');
  gh2.head = sha('b');
  await review({ gh: gh2, provider: scriptedProvider(all), ctx: makeContext(files(2)) });
  assert.equal(stateOf(gh2).completed_rounds, 2);
  assert.equal(stateOf(gh2).head_sha, sha('b'));
});

test('the budget cannot be reset by rerun, new HEAD or tooling: attempts are capped and stalled HEADs stop', async () => {
  const gh = fakeGithub({ head: sha('a') });
  const ctx = makeContext(files(3));
  let calls = 0;
  for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
    gh.head = sha('abcdef0123456789'[i % 16]);
    const provider = scriptedProvider(() => model.fail());
    try { await review({ gh, provider, ctx }); } catch { /* a stop is fine */ }
    calls += provider.calls.length;
  }
  const s = stateOf(gh);
  assert.equal(calls, MAX_ATTEMPTS, 'the lifetime cap is reached but never exceeded');
  assert.equal(s.attempts_used, calls);
  assert.equal(s.status, 'STOPPED');
  assert.equal(s.completed_rounds, 0);
});

test('no progress on one HEAD stops by itself and says what is unreviewed; same-HEAD reruns then do nothing', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(files(3));
  const none = scriptedProvider((c) => model.ok({ assigned: c.assigned, reviewed: [], unreviewed: c.assigned, complete: false }));
  const r = await review({ gh, provider: none, ctx });
  assert.equal(r.status, 'STOPPED');
  assert.ok(none.calls.length <= 2);
  assert.match(stateOf(gh).reason, /no progress/);
  assert.match(stateOf(gh).reason, /3 of 3 file\(s\) not yet reviewed/);
  const again = scriptedProvider(all);
  const r2 = await review({ gh, provider: again, ctx });
  if (stateOf(gh).stalled_attempts >= 4) assert.equal(again.calls.length, 0, r2.action);
});

test('historical #224: old 2/2 STOPPED with 9/14 calls resumes a true third round on the next HEAD', async () => {
  const changed = files(27);
  const gh = fakeGithub({ head: sha('b') });
  const priorHead = sha('a');
  const preserved = {
    schema_version: 2, repo: REPO, pr_number: PR, head_sha: gh.head,
    status: 'STOPPED', reason: 'Both review rounds are used (2/2); new HEAD was not reviewed.',
    completed_rounds: 2, completed_head_sha: priorHead, attempts_used: 9, stalled_attempts: 0,
    scope: makeScope({ mergeBase: MERGE_BASE, files: changed }), reviewed_files: [],
    findings: [
      { id: 'F001', severity: 'P3', title: 'Read-only UI does not persist', path: changed[1],
        failure_path: 'Suggestion only', verification: 'OPEN', checked_head_sha: priorHead },
      { id: 'F002', severity: 'P2', title: 'Registry write bypasses external guard', path: changed[0],
        failure_path: 'Read-only instance writes the external XLSX', verification: 'FIXED', checked_head_sha: priorHead },
    ],
    updated_at: '2026-11-22T11:28:27.881Z',
  };
  gh.comments.push({ id: '99', source: 'issue', type: 'Bot', login: BOT_LOGIN, body: renderComment(preserved) });
  const provider = scriptedProvider((call) => model.ok({ assigned: call.assigned, prior: [
    { id: 'F002', verification: 'FIXED', evidence: 'Registry guard now rejects write even for an external workbook' },
  ] }));
  const r = await review({ gh, provider, ctx: makeContext(changed) });
  const done = stateOf(gh);
  assert.equal(r.status, 'READY');
  assert.equal(done.completed_rounds, 3);
  assert.equal(provider.calls.length, 3);
  assert.equal(done.attempts_used, 12, 'all nine historical calls remain spent');
  assert.equal(done.head_sha, gh.head);
  assert.equal(done.completed_head_sha, gh.head);
  assert.equal(done.findings.find(f => f.id === 'F002').verification, 'FIXED');
  assert.equal(done.findings.find(f => f.id === 'F002').checked_head_sha, gh.head, 'fix was reverified');
  assert.equal(done.findings.find(f => f.id === 'F001').severity, 'P3');

  gh.head = sha('c');
  const blocked = scriptedProvider(all);
  const after = await review({ gh, provider: blocked, ctx: makeContext(changed) });
  assert.equal(after.action, 'budget_stop');
  assert.equal(blocked.calls.length, 0, 'a fourth round is forbidden even with unused lifetime budget');
  assert.equal(stateOf(gh).attempts_used, 12);
});

test('historical #229: capacity STOPPED at 12/14 resumes on the same HEAD and completes round 3', async () => {
  const changed = files(37);
  const gh = fakeGithub({ head: sha('b') });
  const original = {
    schema_version: 2, repo: REPO, pr_number: PR, head_sha: gh.head,
    status: 'STOPPED',
    reason: '37 file(s) still to review need at least 6 model executions (a batch is at most 10 files or about 70 KB of diff), but only 2 of 14 remain for this pull request. Split the pull request or review it manually.',
    completed_rounds: 2, completed_head_sha: sha('a'), attempts_used: 12, stalled_attempts: 0,
    scope: makeScope({ mergeBase: MERGE_BASE, files: changed }), reviewed_files: [], findings: [],
    updated_at: '2026-11-24T03:33:27.114Z',
  };
  gh.comments.push({ id: '99', source: 'issue', type: 'Bot', login: BOT_LOGIN, body: renderComment(original) });
  // 3 large inline diffs and 34 small files require six batches (3 + 3 + the remaining small files).
  const ctx = makeContext(changed, { bigDiff: changed.slice(0, 3) });
  const provider = scriptedProvider(all);
  const r = await review({ gh, provider, ctx });
  const done = stateOf(gh);
  assert.equal(r.status, 'READY');
  assert.equal(provider.calls.length, 6);
  assert.equal(done.completed_rounds, 3);
  assert.equal(done.attempts_used, 18, 'the 12 historical calls remain spent');
  assert.equal(done.completed_head_sha, gh.head);
  assert.equal(gh.comments.length, 1);
  const again = scriptedProvider(all);
  await review({ gh, provider: again, ctx });
  assert.equal(again.calls.length, 0, 'same completed HEAD is reused');
  gh.head = sha('c');
  const blocked = scriptedProvider(all);
  const after = await review({ gh, provider: blocked, ctx });
  assert.equal(after.action, 'budget_stop');
  assert.equal(blocked.calls.length, 0);
  assert.equal(stateOf(gh).attempts_used, 18);
});

test('legacy #219 capacity STOPPED repairs false stall and completes round 2 with existing calls preserved', async () => {
  const changed = files(27);
  const gh = fakeGithub({ head: sha('b') });
  const oldHead = sha('a');
  const original = {
    schema_version: 2, repo: REPO, pr_number: PR, head_sha: gh.head, status: 'STOPPED',
    // Exact reason published on #219 by the old ten-call preflight, which did not invoke a model.
    reason: '27 file(s) still to review need at least 5 model executions (a batch is at most 10 files or about 70 KB of diff), but only 4 of 10 remain for this pull request. Split the pull request or review it manually.',
    completed_rounds: 1, completed_head_sha: oldHead, attempts_used: 6, stalled_attempts: 4,
    scope: makeScope({ mergeBase: MERGE_BASE, files: changed }),
    reviewed_files: [],
    findings: [{ id: 'F001', severity: 'P2', title: 'Trash count stays stale', path: changed[0],
      failure_path: 'Trashed sample count changes without changing sidebar cache key', verification: 'OPEN', checked_head_sha: oldHead }],
    updated_at: '2026-11-21T16:45:55.832Z',
  };
  const saved = (gh2, record) => gh2.comments.push({ id: '99', source: 'issue', type: 'Bot', login: BOT_LOGIN, body: renderComment(record) });
  saved(gh, original);

  // Three ~60KB diffs plus 24 normal files require five batches under the 70KB/10-files limits.
  const provider = scriptedProvider((call) => model.ok({ assigned: call.assigned,
    prior: [{ id: 'F001', verification: 'FIXED', evidence: 'cache key now includes trashed sample count' }] }));
  const result = await review({ gh, provider, ctx: makeContext(changed, { bigDiff: changed.slice(0, 3) }) });
  assert.equal(result.status, 'READY');
  assert.equal(provider.calls.length, 5, 'a formerly blocked review can use the additional capacity');
  const done = stateOf(gh);
  assert.equal(done.attempts_used, 11, 'six historic calls stay spent; five new calls are counted');
  assert.equal(done.completed_rounds, 2, 'no extra business review round');
  assert.equal(done.findings[0].verification, 'FIXED');
  assert.equal(done.stalled_attempts, 0);

  // Never mistake real repeated no-progress attempts for an old capacity preflight.
  const held = fakeGithub({ head: gh.head });
  saved(held, { ...original, reason: 'Repeated attempts on this HEAD made no progress' });
  const noMore = scriptedProvider((call) => model.ok({ assigned: call.assigned }));
  const unchanged = await review({ gh: held, provider: noMore, ctx: makeContext(changed) });
  assert.equal(unchanged.action, 'hold');
  assert.equal(noMore.calls.length, 0);
  assert.equal(stateOf(held).stalled_attempts, 4);
});

test('coverage is checked by the program: outside paths, complete=false with every path listed, and unread truncated diffs earn no credit', async () => {
  const gh = fakeGithub();
  const names = ['src/a.js', 'src/b.js', 'src/c.js'];
  const lying = scriptedProvider((c) => model.ok({ assigned: c.assigned, reviewed: c.assigned, unreviewed: [], complete: false }));
  const r = await review({ gh, provider: lying, ctx: makeContext(names) });
  assert.equal(r.status, 'STOPPED');
  assert.deepEqual(stateOf(gh).reviewed_files, [], 'complete=false is never overridden by a list of paths');

  const gh2 = fakeGithub();
  const big = makeContext(['src/big.js', 'src/small.js'], { bigDiff: ['src/big.js'], bigDiffBytes: 120_000 });
  const unread = scriptedProvider((c) => model.ok({ assigned: c.assigned }));
  await review({ gh: gh2, provider: unread, ctx: big });
  assert.notEqual(stateOf(gh2).status, 'READY', 'the truncated file was never read');
  assert.match(unread.calls[0].prompt, /diff too large to inline: Read \.review-context\/pr\.diff/);
  const gh3 = fakeGithub();
  const read = scriptedProvider((c) => model.ok({ assigned: c.assigned, reads: [{ key: 'ctx:pr.diff', total: 1e9, spans: [[1, 1e9]] }] }));
  await review({ gh: gh3, provider: read, ctx: big });
  assert.equal(stateOf(gh3).status, 'READY');
});

test('draft PRs cost nothing; a missing context or snapshot is refused before any attempt is recorded', async () => {
  const draft = fakeGithub({ draft: true });
  const p = scriptedProvider(all);
  const r = await review({ gh: draft, provider: p, ctx: makeContext(files(2)) });
  assert.equal(r.action, 'wait_draft');
  assert.equal(draft.writes.length, 0);
  assert.equal(p.calls.length, 0);

  const gh = fakeGithub();
  const broken = () => { throw new Error('Missing Git diff block for 1 changed file(s)'); };
  await assert.rejects(review({ gh, provider: scriptedProvider(all), ctx: broken }), /Missing Git diff block/);
  assert.equal(gh.writes.length, 0);
});

test('binary files and ignore rules are outside the scope and said so, never silently reviewed', async () => {
  const gh = fakeGithub();
  const ctx = makeContext(['src/a.js', 'assets/data.bin', 'logo.png', 'gen/out.js'], { binary: ['assets/data.bin'], ignore: 'gen/\n' });
  const provider = scriptedProvider(all);
  await review({ gh, provider, ctx });
  const s = stateOf(gh);
  assert.deepEqual(provider.calls[0].assigned, ['src/a.js']);
  assert.equal(s.scope.total_files, 1);
  assert.equal(s.scope.skipped_files, 3);
  assert.match(s.reason, /3 file\(s\) were outside the review scope/);
});

test('more blocking findings than the state can hold is STOPPED, never READY and never truncated silently', async () => {
  const gh = fakeGithub();
  const many = Array.from({ length: 60 }, (_, i) => ({ severity: 'P2', title: `bug ${i}`, path: 'src/f00.js', failure_path: 'x' }));
  const provider = scriptedProvider((c) => model.ok({ assigned: c.assigned, findings: many.slice((c.n - 1) * 20, c.n * 20) }));
  const r = await review({ gh, provider, ctx: makeContext(files(25)) });
  assert.equal(r.status, 'STOPPED');
  assert.match(stateOf(gh).reason, /More blocking findings/);
  assert.equal(stateOf(gh).completed_rounds, 0);
  assert.equal(stateOf(gh).findings.length, 40);
});

test('the model gets no GitHub credentials: the provider is only ever handed a prompt', async () => {
  const gh = fakeGithub();
  const provider = scriptedProvider(all);
  await review({ gh, provider, ctx: makeContext(files(2)) });
  assert.ok(!/GH_TOKEN|ghs_/.test(provider.calls[0].prompt));
  assert.ok(assignedFrom(provider.calls[0].prompt).length === 2);
  assert.equal(REPO, 'owner/repo');
  assert.equal(PR, 7);
});

test('a first-time out-of-range pull request is stopped honestly before any model call', async () => {
  const gh = fakeGithub();
  const provider = scriptedProvider(all);
  const r = await review({ gh, provider, ctx: makeContext(files(401)) });
  assert.equal(r.status, 'STOPPED');
  assert.equal(provider.calls.length, 0);
  assert.equal(stateOf(gh).attempts_used, 0);
});
