/**
 * Plugin configuration: one validated, detachable policy object.
 *
 * The row's `config` in `cordis.patch.yml` is untrusted input (it may come from
 * a user patch layer), so every field is validated here exactly once, at
 * activation, the way the shipped `@deepseek-ai/dsh-session-title-llm` row does
 * it: unknown keys and wrong types throw, which fails activation loudly instead
 * of silently rewriting prompts with a half-applied policy.
 *
 * `provider` and `model` stay optional. When they are absent the host half asks
 * the composition's `agentDefaultModel` service for the current selection, so a
 * stock profile works with no extra configuration and no API key in this
 * package.
 *
 * @module dsh-prompt-enhance/config
 */

/** Accepted input characters before the model call is refused. */
export const DEFAULT_MAX_INPUT_LENGTH = 4000;

/** Wall-clock budget for one rewrite, including the adapter's own I/O. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Upper bound for the rewritten prompt. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1200;

/** Sampling temperature; the meta prompt wants faithful rewriting, not invention. */
export const DEFAULT_TEMPERATURE = 0.3;

/** Node's timer bound (2^31 - 1 ms); a larger value would fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Every key this plugin accepts; anything else fails activation. */
const CONFIG_KEYS = new Set([
  'provider',
  'model',
  'timeoutMs',
  'maxInputLength',
  'maxOutputTokens',
  'temperature',
  'enableButton',
]);

/** Throw one configuration error prefixed with the plugin name. */
function fail(message) {
  throw new Error(`prompt-enhance: ${message}`);
}

/** Require a finite number inside an inclusive range. */
function numberIn(name, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

/** Require a non-negative integer inside an inclusive range. */
function integerIn(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Resolve the row's raw configuration into the policy the host half uses.
 *
 * @param raw - untrusted `config` object handed to `apply`; `undefined` means defaults.
 * @returns a frozen policy with every default materialized.
 * @throws {Error} on an unknown key, a wrong type, or a provider without model.
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    fail('config must be an object');
  }
  const value = raw ?? {};
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) fail(`unknown config key "${key}"`);
  }

  const hasProvider = value.provider !== undefined;
  if (hasProvider !== (value.model !== undefined)) {
    fail('provider and model must be supplied together');
  }
  if (hasProvider && (typeof value.provider !== 'string' || value.provider.length === 0)) {
    fail('provider must be a non-empty string');
  }
  if (hasProvider && (typeof value.model !== 'string' || value.model.length === 0)) {
    fail('model must be a non-empty string');
  }

  if (value.enableButton !== undefined && typeof value.enableButton !== 'boolean') {
    fail('enableButton must be a boolean');
  }

  const timeoutMs = value.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : integerIn('timeoutMs', value.timeoutMs, 1, MAX_TIMER_DELAY_MS);
  const maxInputLength = value.maxInputLength === undefined
    ? DEFAULT_MAX_INPUT_LENGTH
    : integerIn('maxInputLength', value.maxInputLength, 1, 1_000_000);
  const maxOutputTokens = value.maxOutputTokens === undefined
    ? DEFAULT_MAX_OUTPUT_TOKENS
    : integerIn('maxOutputTokens', value.maxOutputTokens, 1, 1_000_000);
  const temperature = value.temperature === undefined
    ? DEFAULT_TEMPERATURE
    : numberIn('temperature', value.temperature, 0, 2);

  return Object.freeze({
    provider: hasProvider ? value.provider : undefined,
    model: hasProvider ? value.model : undefined,
    timeoutMs,
    maxInputLength,
    maxOutputTokens,
    temperature,
    enableButton: value.enableButton !== false,
  });
}

/**
 * The subset a browser may see. It is pure policy: no route, no credential,
 * no provider address ever leaves the host half.
 *
 * @param resolved - the policy from {@link resolveConfig}.
 * @returns the client-facing limits.
 */
export function publicLimits(resolved) {
  return Object.freeze({
    enableButton: resolved.enableButton,
    maxInputLength: resolved.maxInputLength,
  });
}

/**
 * Normalize user text without altering its content.
 *
 * @param text - whatever the request body carried.
 * @returns the trimmed text, or an empty string for a non-string.
 */
export function normalizeText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Count characters as code points, so one emoji or one CJK glyph is one unit
 * instead of a UTF-16 pair.
 *
 * @param text - arbitrary string.
 * @returns the code-point length.
 */
export function codePointLength(text) {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/**
 * Whether the normalized text exceeds the configured budget.
 *
 * @param text - normalized user text.
 * @param maxInputLength - resolved limit.
 * @returns true when the text must be refused.
 */
export function exceedsInputLimit(text, maxInputLength) {
  return codePointLength(text) > maxInputLength;
}
