// Shared pieces for the non-Claude providers (DeepSeek, Gemini): the result-schema validation the Claude Agent SDK
// performs for us, small numeric helpers, and the per-execution metadata shape the executor logs.
//
// This is deliberately NOT a plugin/registry layer. There are three fixed providers and one fallback slot; the
// provider module resolves them by name. Adding a fourth would be a code change, not a registration.

import { isDeepStrictEqual } from 'node:util';

// Close exploration before the last allowed request. Return honest partial coverage, not a guessed verdict.
export const FINAL_REVIEW_INSTRUCTION = 'Return the final review now as one JSON object matching the review schema exactly. No more tools are available. Report only files actually reviewed; list every remaining assigned file in coverage.unreviewedPaths and set coverage.complete=false if any remain. Preserve supported findings and prior-finding verdicts; do not invent coverage or evidence. JSON only.';

export const RESULT_ERROR_KINDS = Object.freeze(['none', 'config', 'unavailable', 'timeout', 'turns', 'budget', 'malformed', 'execution']);

export const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
export const intOrNull = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

export const failure = (errorKind, error, meta) => ({
  ok: false, structured: null, errorKind, error: String(error).slice(0, 300), meta,
});

const typeOf = (value) => {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};

// A strict-but-small JSON Schema subset: exactly what the review result schema uses (object/array/string/integer/
// boolean, required, properties, additionalProperties:false, enum, length/count bounds, items). The point is to fail
// a provider result that the Claude SDK would have rejected, not to implement JSON Schema.
export function validateAgainstSchema(value, schema, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  const expected = schema.type === undefined
    ? null
    : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (expected) {
    const actual = typeOf(value);
    const matches = expected.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!matches) {
      errors.push(`${path} must be ${expected.join('|')} (got ${actual})`);
      return errors;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} has fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => validateAgainstSchema(item, schema.items, `${path}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validateAgainstSchema(child, schema.properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

export function validateResult(value, schema) {
  const errors = validateAgainstSchema(value, schema);
  return errors.length ? { ok: false, error: errors.slice(0, 4).join('; ') } : { ok: true };
}


/** Limits for descriptive text only. Paths, severity, verdicts, list membership and all coverage fields are not editable. */
function repairableTextFields(value, schema) {
  const props = schema?.properties ?? {};
  const fields = [
    { path: ['summary'], limit: props.summary?.maxLength },
    { path: ['coverage', 'note'], limit: props.coverage?.properties?.note?.maxLength },
  ];
  for (const [list, keys] of [['findings', ['title', 'failure_path']], ['prior_findings', ['evidence']]]) {
    if (!Array.isArray(value?.[list])) continue;
    for (let i = 0; i < value[list].length; i++) {
      for (const key of keys) fields.push({ path: [list, i, key], limit: props[list]?.items?.properties?.[key]?.maxLength });
    }
  }
  return fields.filter(({ limit }) => Number.isInteger(limit) && limit > 0);
}

export function reviewLengthInstruction(schema) {
  const props = schema?.properties ?? {};
  const fields = [
    ['summary', props.summary], ['findings[].title', props.findings?.items?.properties?.title],
    ['findings[].failure_path', props.findings?.items?.properties?.failure_path],
    ['prior_findings[].evidence', props.prior_findings?.items?.properties?.evidence],
    ['coverage.note', props.coverage?.properties?.note],
  ];
  const limits = fields.filter(([, s]) => Number.isInteger(s?.maxLength)).map(([p, s]) => `${p} <= ${s.maxLength} characters`);
  return limits.length ? `Strict text length limits: ${limits.join('; ')}. Be concise; for failure_path state the trigger, incorrect behavior and consequence, without repeating the same evidence.` : '';
}

const parentOf = (value, path) => path.slice(0, -1).reduce((obj, key) => obj?.[key], value);
const pathLabel = (path) => '$' + path.map((key) => typeof key === 'number' ? `[${key}]` : `.${key}`).join('');

/** Recover ONLY JSON that would already satisfy the strict schema but for overlong descriptive strings.
 * Mask exactly those strings and compare the full remaining object after repair. This rejects removed findings,
 * reordered arrays, changed severity/path/verdict/coverage, and edits to any field that was already valid.
 * The meaning of compressed prose remains a model judgment, not something JSON validation can prove.
 */
export function lengthRepairPlan(original, schema) {
  if (!original || typeof original !== 'object' || Array.isArray(original)) return null;
  const masked = structuredClone(original);
  const fields = repairableTextFields(original, schema).filter(({ path, limit }) => {
    const text = parentOf(original, path)?.[path.at(-1)];
    return typeof text === 'string' && text.length > limit;
  });
  if (!fields.length) return null;
  for (const { path } of fields) parentOf(masked, path)[path.at(-1)] = 'x';
  if (!validateResult(masked, schema).ok) return null;
  const instruction = [
    'FORMAT REPAIR ONLY. The immediately preceding JSON object has overlong text fields.',
    'Return the same complete JSON object. Shorten ONLY these fields, preserving their meaning, concrete trigger, incorrect behavior, consequence and evidence:',
    ...fields.map(({ path, limit }) => `${pathLabel(path)}: maximum ${limit} characters`),
    'Keep every other field exactly unchanged, including all findings, array order, severity, paths, prior verdicts and coverage. No tools, no new review, no dropped or invented findings. JSON only.',
  ].join('\n');
  return {
    instruction,
    accepts(repaired) {
      if (!validateResult(repaired, schema).ok) return false;
      const comparable = structuredClone(repaired);
      for (const { path } of fields) {
        const parent = parentOf(comparable, path);
        if (!parent || typeof parent[path.at(-1)] !== 'string' || !parent[path.at(-1)].trim()) return false;
        parent[path.at(-1)] = 'x';
      }
      return isDeepStrictEqual(masked, comparable);
    },
  };
}

function inspectReviewText(text, schema) {
  let value;
  if (!text?.trim()) return { parsed: false, error: 'empty structured result' };
  try { value = JSON.parse(text); }
  catch { return { parsed: false, error: 'structured result was not JSON' }; }
  return { parsed: true, value, ...validateResult(value, schema) };
}

// For normal budgets reserve one final request plus at most one repair; one- and two-turn calls retain
// their existing finalization behavior. request() enforces the provider's normal usage, deadline and tool rules.
export const explorationTurnLimit = (maxTurns) => Math.max(0, Math.max(1, maxTurns) - (maxTurns >= 3 ? 2 : 1));

export async function finishReviewText({ initialText, schema, canRequest, request }) {
  let result = inspectReviewText(initialText, schema);
  if (!result.parsed && canRequest()) {
    result = inspectReviewText(await request([FINAL_REVIEW_INSTRUCTION, reviewLengthInstruction(schema)].filter(Boolean).join('\n')), schema);
  }
  if (result.ok) return { ok: true, structured: result.value };
  // An unparseable/structurally invalid result has no reliable findings to compare; do not let a repair
  // invent a replacement review. Only the explicitly permitted overlong strings may change.
  const plan = result.parsed ? lengthRepairPlan(result.value, schema) : null;
  if (!plan || !canRequest()) return { ok: false, error: result.error };
  const repaired = inspectReviewText(await request(plan.instruction), schema);
  if (!repaired.ok) return { ok: false, error: `format repair failed schema validation: ${repaired.error}`, repaired: true };
  if (!plan.accepts(repaired.value)) return { ok: false, error: 'format repair changed protected fields or removed evidence', repaired: true };
  return { ok: true, structured: repaired.value, repaired: true };
}

export function baseMeta({ provider, model, effort, maxTurns, startedAt, maxBudgetUsd = null }) {
  return {
    provider, requested_model: model, resolved_model: model, effort: effort ?? null, max_turns: maxTurns,
    num_turns: 0, tool_calls: 0, duration_ms: Date.now() - startedAt,
    input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null,
    thoughts_tokens: null, total_tokens: null,
    cost_usd_nominal: null, cost_source: 'unknown', usd_cap: num(maxBudgetUsd),
  };
}

// A nominal USD estimate from configured per-million-token prices. Without prices the cost is unknown, never zero:
// "not free", just not reported.
export function estimateCostUsd({ usage, inputPrice, outputPrice, cachedInputPrice = null, outputIncludesThoughts = false }) {
  if (!(Number.isFinite(inputPrice) && inputPrice >= 0) || !(Number.isFinite(outputPrice) && outputPrice >= 0)) return null;
  const input = num(usage?.input_tokens) ?? 0;
  const cached = num(usage?.cache_read_input_tokens) ?? 0;
  const output = (num(usage?.output_tokens) ?? 0) + (outputIncludesThoughts ? 0 : (num(usage?.thoughts_tokens) ?? 0));
  const cachedPrice = Number.isFinite(cachedInputPrice) ? cachedInputPrice : inputPrice;
  const billedInput = Math.max(0, input - cached);
  return (billedInput * inputPrice + cached * cachedPrice + output * outputPrice) / 1_000_000;
}

export function priceFromEnv(env, key) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function checkBudgetCap({ meta, usage, inputPrice, outputPrice, cachedInputPrice = null, outputIncludesThoughts = false }) {
  if (meta.usd_cap === null || inputPrice === null || outputPrice === null) return null;
  const spent = estimateCostUsd({ usage, inputPrice, outputPrice, cachedInputPrice, outputIncludesThoughts });
  if (spent !== null && spent > meta.usd_cap) {
    return `${meta.provider} nominal cost ${spent.toFixed(4)} exceeded the per-execution cap ${meta.usd_cap}`;
  }
  return null;
}

// A provider API key must only ever be sent to an https endpoint, or to a local test server. `allowAnyHost` exists
// for providers whose base URL is meant to be swapped (DeepSeek -> an OpenAI-compatible gateway).
export function normalizeBaseUrl(raw, { fallback, hosts = null }) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return fallback;
  let url;
  try { url = new URL(value); } catch { throw new Error(`provider base URL is not a valid URL: ${value}`); }
  const local = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(value);
  if (url.protocol !== 'https:' && !local) {
    throw new Error(`provider base URL must be https (or a local test server): ${value}`);
  }
  if (hosts && !local && !hosts.includes(url.host)) {
    throw new Error(`provider base URL must be ${hosts.join(' or ')}: ${value}`);
  }
  return value;
}

export function statusClass(status) {
  if (status === 401 || status === 403) return 'config';
  if (status === 402 || status === 429) return 'unavailable';
  if (status >= 500 && status <= 599) return 'unavailable';
  if (status === 404) return 'config';
  return 'execution';
}

// `ReadOnlyToolGateway.getToolDeclarations` is static on the real class, while test doubles may define it on the
// instance. Checking both keeps every provider wired to the real Read/Glob/Grep schemas.
export function readToolDeclarations(toolGateway) {
  return toolGateway?.getToolDeclarations?.() ?? toolGateway?.constructor?.getToolDeclarations?.() ?? [];
}
