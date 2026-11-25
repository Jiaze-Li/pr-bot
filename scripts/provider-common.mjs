// Shared pieces for the non-Claude providers (DeepSeek, Gemini): the result-schema validation the Claude Agent SDK
// performs for us, small numeric helpers, and the per-execution metadata shape the executor logs.
//
// This is deliberately NOT a plugin/registry layer. There are three fixed providers and one fallback slot; the
// provider module resolves them by name. Adding a fourth would be a code change, not a registration.

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
