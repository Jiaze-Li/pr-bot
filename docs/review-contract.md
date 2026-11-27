# Review result contract (schema_version 2)

Owner: pr-bot. Consumers (agent-delivery) pin this file and `tests/fixtures/review-contract.json` by commit SHA. Code: `scripts/review-contract.mjs` (parse, validate, render, consumer decision) and `scripts/review-engine.mjs` (state transitions). Regenerate fixtures with `npm run review:fixtures`; check any fixtures file with `npm run test:compat -- --in <file>`.

## The one record

One conversation comment per PR, authored by the review App (`jiaze-claude-review-bot[bot]`, type `Bot`). It starts with the locator `<!-- agent-delivery:v1 -->` (a locator only, not a version), then a ```json block, then text generated from the JSON. Only the JSON is authoritative. The commit status `claude-review-bot/review` is its projection.

```jsonc
{
  "schema_version": 2,
  "repo": "owner/repo", "pr_number": 123,
  "head_sha": "<40 hex>",            // the HEAD this state describes
  "status": "IN_PROGRESS | CHANGES_REQUESTED | READY | STOPPED",
  "reason": "human readable",
  "completed_rounds": 0,             // 0..3 complete review conclusions published for this PR
  "completed_head_sha": null,        // HEAD of the latest completed round on the CURRENT diff, else null (also null while a concluded round is being redone after the merge-base moved)
  "attempts_used": 1,                // 0..30 model executions started (recorded BEFORE the call; failures are not refunded)
  "stalled_attempts": 0,             // consecutive attempts on this HEAD that credited no new file
  "scope": { "merge_base_sha": "...", "files_sha256": "...", "total_files": 26, "skipped_files": 0 },
  "reviewed_files": [],              // files credited so far in the current scope; empty once a round completes
  "findings": [ { "id": "F001", "severity": "P0|P1|P2|P3", "title": "", "path": "", "failure_path": "", "verification": "OPEN|FIXED|STILL_OPEN|UNCERTAIN", "checked_head_sha": "<sha>" } ],
  "updated_at": "ISO", "claimed_at": "ISO (IN_PROGRESS only)"
}
```

A blocking finding is `severity in P0..P2` and `verification != FIXED`. P3 never blocks. `skipped_files` counts files outside the review scope (ignore rules, binary content); the comment says so.

## Consumer rules (`evaluateComment`)

Decision is one of `READY | CHANGES_REQUESTED | STOPPED | WAIT`. `WAIT` is a display result ("no usable final state yet"), never a remote status.

1. The comment must be by the bot identity with type `Bot`, carry the marker and a parseable, valid `schema_version: 2` JSON for this repo and PR. Otherwise: not trusted, `WAIT`. A `schema_version: 1` document is never a pass.
2. `head_sha` must equal both the consumer's local HEAD and the remote's current HEAD. Otherwise `WAIT`. For `READY` and `CHANGES_REQUESTED`, `scope.merge_base_sha` must also equal the PR's current merge-base (a conclusion describes one scope); otherwise `WAIT`. A trusted `STOPPED` for the current HEAD is reported as `STOPPED` whatever scope it last reviewed: the bot has stopped and said why, so waiting would never end.
3. `IN_PROGRESS` is `WAIT`. Otherwise the decision is the status.
4. A `READY` that contradicts its own JSON (blocking finding, or `completed_head_sha != head_sha`) is invalid, hence `WAIT`.

`STOPPED` on the current HEAD means automatic execution cannot continue; `reason` says why and what is unreviewed. If `completed_head_sha != head_sha` and budget remains, asking for a review again (`@jiaze-claude-review-bot review`) resumes it on the same PR.

## Three-round transition (backward-compatible schema_version 2)

The complete review cap is now **3** (previously 2), and **MAX_ATTEMPTS is now 30 total per PR** (previously 14). Existing comments with `completed_rounds: 2`, historical P2 finding IDs, and the actual `attempts_used` are preserved. A previously stopped PR whose HEAD was not reviewed because the old two-round cap was exhausted may receive its third review on the same PR, provided the HEAD differs from `completed_head_sha` and there are enough remaining model executions. A previous capacity-preflight STOPPED (such as #229) may resume on the same PR under the 30-call cap, with historical attempts preserved. No reset or invented READY is permitted. Consumers must accept `CHANGES_REQUESTED` at round 2 and `READY` at round 3 before enabling this producer policy.

## Rules the bot enforces

- Non-draft PRs only. First Ready, push, review command and workflow rerun all enter the same decision (`planRun`).
- Round = one complete review conclusion for one HEAD. Coverage is built from sequential batches (bounded by file count and ONE shared ~70 KB diff prompt budget) and credited by the program: only files assigned to the batch, reported reviewed, not reported unreviewed; `complete=false` without naming what is missing earns no credit. Each complete per-file diff within the batch budget is included in the prompt, regardless of file status; only diffs larger than that budget require real gateway `Read` evidence covering the entire corresponding block of `.review-context/pr.diff` (segments may be combined; cut lines do not count). Reading an entire HEAD source file is optional context, never a substitute for unseen diff content. The prompt lists deleted paths so dangling references can be found with `Grep`. A file larger than the batch budget runs alone; the required diff Read calls still count against the attempt's turn budget. No file is credited solely from a model claim when its changed diff was truncated.
- Rounds 1 and 2 complete: no blocker -> `READY`; blocker or `UNCERTAIN` -> `CHANGES_REQUESTED` so a fix can be pushed and reviewed again. Round 3 (final) complete: no blocker -> `READY`; blocker or `UNCERTAIN` -> `STOPPED`. There is no fourth round; later HEADs are `STOPPED` unreviewed. Incomplete coverage never publishes `CHANGES_REQUESTED`, even with a P2 in hand.
- Earlier blockers are re-verified on the new HEAD (`FIXED` and `STILL_OPEN` need evidence; a bare claim is `UNCERTAIN`). A blocker nobody verified is `UNCERTAIN`, never fixed. Within the same HEAD, an uncertain prior verdict remains eligible for later batches; affirmative evidence supersedes uncertainty, but conflicting affirmative failure evidence remains blocking (including newly reported OPEN findings). A later omission or uncertainty cannot undo a supported verdict. Findings are only added or escalated: IDs are stable, a repeated issue never loses to an old P3/FIXED, nothing is truncated to reach `READY`. More than 40 findings is `STOPPED`.
- The round count and its conclusion are written in the same single comment PATCH. Before every write the comment must still be what the run last wrote; a write whose response is lost is verified by re-reading.
- Same HEAD, complete, same merge-base: reuse (no call, no count). Same HEAD, different merge-base: the diff is new, so the old conclusion is void and the round that concluded on it is **reopened** (`completed_rounds - 1`, `completed_head_sha = null`) and redone as the current phase: it does not use up the one fix/verification opportunity, but every model attempt it takes is counted. With no attempts left the bot publishes `STOPPED` for the current HEAD with `scope.merge_base_sha` set to the current baseline. Same HEAD, incomplete: resume while budget remains. New HEAD while incomplete: coverage restarts, attempts and findings carry over. HEAD change during an attempt: the attempt stays spent and its result is discarded.
- Whole-PR preflight: before any attempt is spent, the files still to review are batched (at most 10 files, ~70 KB of diff and the Read calls the attempt's turns allow per batch); if that needs more executions than remain of the 30, the PR is `STOPPED` with the numbers, no model call, no attempt used. Capacity preflight never increments `stalled_attempts` (only real no-progress model attempts do). Historic STOPPED comments that falsely recorded a capacity-preflight stall are recognized by their exact reason and rechecked against the current budget; genuine model stalls stay locked. Finite capacity is deliberate: about 300 small files in a single pass; three review rounds share the SAME lifetime budget.
- Budget per PR (never reset by rerun, HEAD change or tooling): 30 model executions, each by default at most 14 turns, 8 minutes and USD 0.50 (SDK nominal estimate, not a bill) -> worst case at default per-execution limits: 420 turns, 240 minutes, USD 15.00 nominal (previous 14-execution cap: USD 7.00). One workflow run also stops after 8 attempts or 30 minutes; 4 consecutive attempts on one HEAD without progress stop that HEAD.

## One-time migration from schema_version 1

`scripts/migrate-v1.mjs` (workflow `migrate-v1.yml`, dry-run by default) rewrites the same comment in place: `completed_rounds` is `review_runs_used` only if v1 recorded complete coverage, else 0 (a case that cannot be determined is reported, not guessed); `attempts_used = review_runs_used`; findings are kept; progress starts empty. A document that is already v2 is left untouched. Before migration the runner refuses to treat a v1 document as state.
