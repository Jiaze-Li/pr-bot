// Which review model runs, and in what order. Three fixed providers, one optional fallback slot, resolved from
// configuration. There is no registry, no plugin interface, no voting: the primary runs; if it fails to execute, the
// fallback runs the SAME prompt, tools and schema on the SAME attempt budget (each execution is one attempt).
//
// Defaults preserve production behaviour: Claude only, no fallback. Switching the review model is a configuration
// change (REVIEW_PROVIDER), never something the bot does on its own.
import { runClaude } from './claude-provider.mjs';
import { runDeepSeek, deepseekModel } from './deepseek-provider.mjs';
import { runGemini, geminiModel } from './gemini-provider.mjs';

export const PROVIDER_NAMES = Object.freeze(['claude', 'deepseek', 'gemini']);

const CREDENTIAL_ENV = Object.freeze({
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
});

const RUNNERS = Object.freeze({ claude: runClaude, deepseek: runDeepSeek, gemini: runGemini });

export function providerModel(name, env = process.env) {
  if (name === 'deepseek') return deepseekModel(env);
  if (name === 'gemini') return geminiModel(env);
  return env?.REVIEW_CLAUDE_MODEL || env?.CLAUDE_MODEL || 'sonnet';
}

export function providerCredentialProblem(name, env = process.env) {
  const key = CREDENTIAL_ENV[name];
  if (!key) return `unknown review provider "${name}" (expected one of ${PROVIDER_NAMES.join(', ')})`;
  return env?.[key] ? null : `${key} is not configured`;
}

const normalizeName = (raw) => String(raw ?? '').trim().toLowerCase();

// -> { primary: { name, model }, fallback: { name, model } | null }
// An unknown or repeated name is a configuration error, never a silent downgrade.
export function resolveProviderConfig(env = process.env) {
  const primaryName = normalizeName(env?.REVIEW_PROVIDER || 'claude');
  if (!PROVIDER_NAMES.includes(primaryName)) {
    throw new Error(`REVIEW_PROVIDER "${env?.REVIEW_PROVIDER}" is not one of ${PROVIDER_NAMES.join(', ')}`);
  }
  const fallbackRaw = normalizeName(env?.REVIEW_FALLBACK_PROVIDER);
  if (fallbackRaw && !PROVIDER_NAMES.includes(fallbackRaw)) {
    throw new Error(`REVIEW_FALLBACK_PROVIDER "${env?.REVIEW_FALLBACK_PROVIDER}" is not one of ${PROVIDER_NAMES.join(', ')}`);
  }
  const primary = { name: primaryName, model: providerModel(primaryName, env) };
  // A fallback that would run the identical provider would just repeat the same failure against the budget.
  const fallback = fallbackRaw && fallbackRaw !== primaryName
    ? { name: fallbackRaw, model: providerModel(fallbackRaw, env) }
    : null;
  return { primary, fallback };
}

export function providerRunner(name) {
  const runner = RUNNERS[name];
  if (!runner) throw new Error(`unknown review provider "${name}"`);
  return runner;
}

export const PROVIDER_CREDENTIAL_ENV = CREDENTIAL_ENV;
