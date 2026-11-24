// Gemini through the generative-language REST API as the fallback review provider: the same prompt, the same
// Read/Glob/Grep declarations executed by the host gateway, and the same result schema validated before returning.
//
// Used only when the primary provider fails to execute. Nothing here decides whether a review is good enough; that
// is the executor's job. One call here is one attempt in the PR's budget, charged by the caller.
import {
  baseMeta, estimateCostUsd, failure, normalizeBaseUrl, num, priceFromEnv, readToolDeclarations, statusClass, validateResult,
} from './provider-common.mjs';

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
export const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
export const MAX_CONTEXT_BYTES = 1_500_000;
const RESERVE_BYTES = 100_000;

// Gemini accepts only a subset of JSON Schema. Drop everything else (length bounds stay enforced by our validator).
const GEMINI_SCHEMA_KEYS = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems',
  'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required',
  'propertyOrdering',
]);

export function toGeminiJsonSchema(value, key = null) {
  if (Array.isArray(value)) return value.map((item) => toGeminiJsonSchema(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (key === 'properties' || key === '$defs') {
      out[childKey] = toGeminiJsonSchema(childValue, childKey);
      continue;
    }
    if (!GEMINI_SCHEMA_KEYS.has(childKey)) continue;
    out[childKey] = toGeminiJsonSchema(childValue, childKey);
  }
  return out;
}

export function geminiBaseUrl(env = process.env) {
  // The API key is only ever sent to Google, or to a local test server.
  return normalizeBaseUrl(env?.GEMINI_API_BASE_URL, { fallback: GEMINI_HOST, hosts: [new URL(GEMINI_HOST).host] });
}

export function geminiModel(env = process.env) {
  return env?.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

export function geminiEffort(env = process.env) {
  const value = String(env?.GEMINI_THINKING_LEVEL ?? 'medium').trim();
  return ['minimal', 'low', 'medium', 'high'].includes(value) ? value : 'medium';
}

// -> { ok, structured, errorKind, error, meta }
export async function runGemini({
  prompt, schema, toolGateway, env = process.env, maxTurns = 14, maxBudgetUsd = null, timeoutMs = 8 * 60 * 1000,
  model = geminiModel(env), effort = geminiEffort(env), fetchImpl = fetch, maxOutputTokens = 32_768,
}) {
  if (!toolGateway) throw new Error('a tool gateway is required: the model never gets native tools');
  const startedAt = Date.now();
  const meta = baseMeta({ provider: 'gemini', model, effort, maxTurns, startedAt, maxBudgetUsd });
  const apiKey = env?.GEMINI_API_KEY;
  if (!apiKey) return failure('config', 'GEMINI_API_KEY is not set', meta);
  let baseUrl;
  try { baseUrl = geminiBaseUrl(env); } catch (error) { return failure('config', error.message, meta); }

  const inputPrice = priceFromEnv(env, 'GEMINI_INPUT_PRICE_PER_MTOK');
  const outputPrice = priceFromEnv(env, 'GEMINI_OUTPUT_PRICE_PER_MTOK');
  const cachedPrice = priceFromEnv(env, 'GEMINI_CACHED_INPUT_PRICE_PER_MTOK');
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, thoughts_tokens: 0, total_tokens: 0 };
  let sawUsage = false;
  const addUsage = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    sawUsage = true;
    const prompt_ = num(raw.promptTokenCount);
    const output = num(raw.candidatesTokenCount);
    const thoughts = num(raw.thoughtsTokenCount);
    const total = num(raw.totalTokenCount);
    const cached = num(raw.cachedContentTokenCount);
    if (prompt_ !== null) usage.input_tokens += prompt_;
    if (output !== null) usage.output_tokens += output;
    if (thoughts !== null) usage.thoughts_tokens += thoughts;
    if (total !== null) usage.total_tokens += total;
    if (cached !== null) usage.cache_read_input_tokens += cached;
  };
  const finalizeMeta = (extra = {}) => {
    Object.assign(meta, extra, {
      duration_ms: Date.now() - startedAt,
      input_tokens: sawUsage ? usage.input_tokens : null,
      output_tokens: sawUsage ? usage.output_tokens : null,
      cache_read_input_tokens: sawUsage ? usage.cache_read_input_tokens : null,
      thoughts_tokens: sawUsage ? usage.thoughts_tokens : null,
      total_tokens: sawUsage ? usage.total_tokens : null,
    });
    if (sawUsage) {
      const cost = estimateCostUsd({ usage, inputPrice, outputPrice, cachedInputPrice: cachedPrice });
      if (cost !== null) { meta.cost_usd_nominal = cost; meta.cost_source = 'configured-prices'; }
    }
    meta.over_budget = Boolean(meta.usd_cap !== null && meta.cost_usd_nominal !== null && meta.cost_usd_nominal > meta.usd_cap);
    return meta;
  };

  const deadline = startedAt + Math.max(1000, timeoutMs);
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const send = async (body) => {
    const bodyText = JSON.stringify(body);
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_CONTEXT_BYTES) {
      throw Object.assign(new Error(`Gemini request exceeds ${MAX_CONTEXT_BYTES} bytes`), { kind: 'execution' });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error(`Gemini timed out after ${timeoutMs}ms`), { kind: 'timeout' });
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: bodyText,
        signal: AbortSignal.timeout(remaining),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw Object.assign(new Error(timedOut ? `Gemini timed out after ${timeoutMs}ms` : `Gemini request failed: ${error?.message ?? error}`),
        { kind: timedOut ? 'timeout' : 'execution' });
    }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 300); } catch { /* body optional */ }
      throw Object.assign(new Error(`Gemini HTTP ${response.status}: ${detail}`), { kind: statusClass(response.status), status: response.status });
    }
    try {
      return await response.json();
    } catch (error) {
      throw Object.assign(new Error(`Gemini returned an unreadable response: ${error?.message ?? error}`), { kind: 'execution' });
    }
  };

  const declarations = readToolDeclarations(toolGateway).map((decl) => ({
    name: decl.name, description: decl.description, parameters: toGeminiJsonSchema(decl.parameters),
  }));
  const allowed = new Set(declarations.map((d) => d.name));
  const tools = [{ functionDeclarations: declarations }];
  const thinkingConfig = { thinkingLevel: effort };
  const contents = [{ role: 'user', parts: [{ text: prompt }] }];
  let turns = 0;
  let toolCalls = 0;
  let resolvedModel = model;
  let lastCandidate = null;

  try {
    while (turns < Math.max(1, maxTurns)) {
      turns += 1;
      const payload = await send({ contents, tools, generationConfig: { thinkingConfig, maxOutputTokens } });
      if (typeof payload?.modelVersion === 'string' && payload.modelVersion) resolvedModel = payload.modelVersion;
      addUsage(payload?.usageMetadata);
      const candidate = payload?.candidates?.[0];
      lastCandidate = candidate;
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const functionCalls = parts.filter((part) => part?.functionCall);
      // Every model part (text, functionCall, thoughtSignature) must go back verbatim in later turns.
      if (parts.length) contents.push({ role: 'model', parts: parts.map((part) => ({ ...part })) });
      if (candidate?.finishReason && ['MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(candidate.finishReason)) {
        return failure('execution', `Gemini stopped with finishReason=${candidate.finishReason}`,
          finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }));
      }
      if (!functionCalls.length) break;
      if (toolCalls + functionCalls.length > maxTurns * 4) {
        return failure('turns', `Gemini exceeded the tool call limit (${maxTurns * 4})`,
          finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }));
      }
      const responses = [];
      for (const part of functionCalls) {
        toolCalls += 1;
        const { name, args, id } = part.functionCall;
        let result;
        if (!allowed.has(name)) {
          result = { ok: false, error: `Tool ${name} is not available. Only ${[...allowed].join(', ')} are supported.` };
        } else {
          result = await toolGateway.runExclusive(() => toolGateway.executeTool(name, args ?? {}));
        }
        let output = result?.ok ? String(result.content ?? '') : String(result?.error ?? 'Tool execution failed');
        const historyBytes = Buffer.byteLength(JSON.stringify(contents), 'utf8');
        const room = Math.max(2048, MAX_CONTEXT_BYTES - historyBytes - RESERVE_BYTES);
        if (Buffer.byteLength(output, 'utf8') > room) output = `${output.slice(0, Math.max(1024, Math.floor(room / 2)))}…[truncated to stay within the Gemini context limit]`;
        responses.push({ functionResponse: { name, response: { output }, ...(id ? { id } : {}) } });
      }
      contents.push({ role: 'user', parts: responses });
      if (Buffer.byteLength(JSON.stringify(contents), 'utf8') >= MAX_CONTEXT_BYTES - RESERVE_BYTES) break;
    }

    const textOf = (candidate) => (candidate?.content?.parts ?? [])
      .map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
    const parse = (text) => {
      if (!text) return null;
      try {
        const value = JSON.parse(text);
        return validateResult(value, schema).ok ? value : null;
      } catch { return null; }
    };
    const direct = parse(textOf(lastCandidate));
    if (direct) {
      return { ok: true, structured: direct, errorKind: 'none', error: null, meta: finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }) };
    }
    if (turns >= Math.max(1, maxTurns)) {
      return failure('turns', `Gemini used the whole ${maxTurns}-turn budget without a structured result`,
        finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }));
    }

    turns += 1;
    const instruction = 'Return the final review now as one JSON object that matches the response schema exactly. No prose.';
    if (contents[contents.length - 1]?.role === 'user') contents[contents.length - 1].parts.push({ text: instruction });
    else contents.push({ role: 'user', parts: [{ text: instruction }] });
    const payload = await send({
      contents,
      generationConfig: { thinkingConfig, maxOutputTokens, responseMimeType: 'application/json', responseSchema: toGeminiJsonSchema(schema) },
    });
    if (typeof payload?.modelVersion === 'string' && payload.modelVersion) resolvedModel = payload.modelVersion;
    addUsage(payload?.usageMetadata);
    const candidate = payload?.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
      return failure('malformed', 'Gemini truncated the structured result (finishReason=MAX_TOKENS)',
        finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }));
    }
    const text = textOf(candidate);
    if (!text) {
      return failure('malformed', 'Gemini returned an empty structured result',
        finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }));
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return failure('malformed', `Gemini structured result was not JSON: ${error.message}`,
        finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }));
    }
    const validation = validateResult(parsed, schema);
    if (!validation.ok) {
      return failure('malformed', `Gemini structured result did not match the review schema: ${validation.error}`,
        finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }));
    }
    return { ok: true, structured: parsed, errorKind: 'none', error: null, meta: finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel }) };
  } catch (error) {
    return failure(error?.kind ?? 'execution', error?.message ?? String(error),
      finalizeMeta({ num_turns: turns, tool_calls: toolCalls, resolved_model: resolvedModel, ...(error?.status ? { http_status: error.status } : {}) }));
  }
}
