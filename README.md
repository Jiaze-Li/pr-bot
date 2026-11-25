# pr-bot

Independent, static pull-request review for Jiaze-Li's repositories. One path for every non-draft PR.

## Use

Nothing to configure per PR. A review starts when a non-draft PR is opened, marked ready, reopened or pushed to. To make sure the current commit has a result (also to resume a stopped review), comment on the PR:

```
@jiaze-claude-review-bot review
```

You get one bot comment (the only record) and the `claude-review-bot/review` commit status:

| Status | Meaning |
| --- | --- |
| IN_PROGRESS | the current round is being reviewed (sequential batches, with resumption) |
| CHANGES_REQUESTED | round 1 or 2 is complete and found unresolved P0/P1/P2: fix them together and push once for the next round (if budget remains) |
| READY | the current commit is completely reviewed and has no unresolved P0/P1/P2 |
| STOPPED | automatic review cannot continue; the comment says why and what is unreviewed |

Up to three complete review rounds per PR, P3 never blocks, and the SAME hard cap of 30 model executions per PR (never reset by a new HEAD). The third round permits additional verification, not extra calls. Details: [docs/review-contract.md](docs/review-contract.md).

## Layout

- `worker/` Cloudflare Worker: verifies the webhook signature and trigger permission, ignores drafts, dispatches `review.yml`.
- `.github/workflows/review.yml` the one review workflow (plan -> exact-HEAD checkout and safe snapshot -> run).
- `scripts/review.mjs` the executor; `review-engine.mjs` pure decisions and transitions; `review-contract.mjs` the shared contract; `model-provider.mjs` which model runs and the one fallback slot; `claude-provider.mjs` / `deepseek-provider.mjs` / `gemini-provider.mjs` the model calls; `tool-gateway.mjs` read-only tools; `materialize-safe-tree.mjs` the sanitized snapshot.
- `scripts/migrate-v1.mjs` + `migrate-v1.yml`: one-time v1 -> v2 migration (delete after the cut-over).

## Configuration

Secrets: `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_*` (Worker deploy). Variables: `APP_ID`, optional `REQUIRE_STATUS_CHECK=true`, optional `REVIEW_MAX_TURNS` (14), `REVIEW_MAX_BUDGET_USD` (0.5), `REVIEW_TIMEOUT_MS` (480000) per model execution. A repository can skip files with a `.reviewbotignore` read from the PR's base commit.

### Review model

The review runs one provider. An optional second provider replaces it only when the first fails to execute (HTTP error, timeout, turn/tool limit, unparseable or schema-invalid result). A result the model did produce is never re-rolled on another model, whatever it concludes.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REVIEW_PROVIDER` | `claude` | `claude`, `deepseek` or `gemini` |
| `REVIEW_FALLBACK_PROVIDER` | none | provider used only after an execution failure of the primary |
| `REVIEW_CLAUDE_MODEL` | `sonnet` | Claude model |
| `DEEPSEEK_MODEL` | `deepseek-flash` | DeepSeek model ID |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | any https OpenAI-compatible base URL (e.g. a gateway), so the endpoint can move |
| `DEEPSEEK_REASONING_EFFORT` | `high` | thinking mode effort: `none`, `low`, `high`, `max` |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model |
| `GEMINI_THINKING_LEVEL` | `medium` | `minimal`, `low`, `medium`, `high` |

Every execution - primary or fallback - is one attempt of the same 30-execution lifetime budget, recorded before the call; a fallback never buys extra attempts. All providers get the same prompt, the same Read/Glob/Grep gateway tools, the same result schema and the same validation. Each execution logs a `REVIEW_DIAGNOSTICS` line with the provider, model, token usage, duration and a nominal cost (the SDK's own estimate, or configured per-Mtok prices, or `unknown` - never a fake zero).

Optional nominal prices per million tokens, used only for that diagnostics estimate: `DEEPSEEK_INPUT_PRICE_PER_MTOK`, `DEEPSEEK_OUTPUT_PRICE_PER_MTOK`, `DEEPSEEK_CACHED_INPUT_PRICE_PER_MTOK`, `GEMINI_INPUT_PRICE_PER_MTOK`, `GEMINI_OUTPUT_PRICE_PER_MTOK`, `GEMINI_CACHED_INPUT_PRICE_PER_MTOK`.

Production stays on Claude until `REVIEW_PROVIDER` is set deliberately; the bot never switches the review model on its own.

## Develop

```
npm ci --legacy-peer-deps && npm test && npm run test:compat
npm run review:fixtures   # regenerate tests/fixtures/review-contract.json
RUN_LIVE_PROVIDER_TESTS=1 DEEPSEEK_API_KEY=... GEMINI_API_KEY=... node --test tests/provider-live.test.mjs
```
