/**
 * One rewrite: validate the text, call the composition's LLM service through an
 * injected `stream`, and answer with the frozen envelope the client half reads.
 *
 * The transport is injected (`input.stream`) on purpose: it lets the tests drive
 * every failure mode — timeout, adapter error, empty completion, truncation —
 * with a fake chunk stream, without a provider, a network, or an API key.
 *
 * Contracts this module keeps:
 * - the envelope is `{ ok: true, result }` or `{ ok: false, error: { code, message } }`;
 * - a failure never carries provider text, request URLs, headers, stack traces,
 *   or the user's input, so nothing sensitive can reach the browser log;
 * - the caller keeps the user's original text: this function only reports.
 *
 * @module dsh-prompt-enhance/rewrite
 */

import { exceedsInputLimit, normalizeText } from './config.js';
import { buildGenerateOptions } from './prompt.js';

/** Stable, client-facing failure codes. */
export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INPUT_TOO_LONG: 'INPUT_TOO_LONG',
  MODEL_NOT_CONFIGURED: 'MODEL_NOT_CONFIGURED',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_FAILED: 'MODEL_FAILED',
  MODEL_TRUNCATED: 'MODEL_TRUNCATED',
  EMPTY_RESULT: 'EMPTY_RESULT',
});

/**
 * Displayable one-line messages. They are product copy, never provider copy:
 * a provider's own message may name endpoints, models, or keys.
 */
const MESSAGES = Object.freeze({
  [ERROR_CODES.INVALID_INPUT]: '输入为空，未调用模型',
  [ERROR_CODES.MODEL_NOT_CONFIGURED]: '没有可用的模型，请先在设置里选择默认模型',
  [ERROR_CODES.MODEL_TIMEOUT]: '模型响应超时，已保留原始输入',
  [ERROR_CODES.MODEL_FAILED]: '模型调用失败，已保留原始输入',
  [ERROR_CODES.MODEL_TRUNCATED]: '增强结果被输出长度限制截断，已保留原始输入',
  [ERROR_CODES.EMPTY_RESULT]: '模型没有返回内容，已保留原始输入',
});

/**
 * Build a failure envelope.
 *
 * @param code - one of {@link ERROR_CODES}.
 * @param message - optional override for product copy.
 * @returns the wire envelope.
 */
export function failure(code, message) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message: message ?? MESSAGES[code] ?? '增强失败，已保留原始输入' }),
  });
}

/**
 * Build a success envelope.
 *
 * @param result - the rewritten prompt.
 * @returns the wire envelope.
 */
export function success(result) {
  return Object.freeze({ ok: true, result });
}

/**
 * Join the text deltas one adapter stream produced.
 *
 * @param chunks - the `StreamChunk` sequence.
 * @returns accumulated text plus the terminal finish kind.
 */
export async function readChunks(chunks) {
  let text = '';
  let finish = { kind: 'stop' };
  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    } else if (chunk.type === 'finish' && chunk.reason !== null && typeof chunk.reason === 'object') {
      finish = chunk.reason;
    }
  }
  return { text, finish };
}

/**
 * Map one terminal finish reason onto the envelope vocabulary.
 *
 * @param finish - the adapter's `FinishReason`.
 * @returns a failure envelope, or `undefined` when the finish is usable.
 */
export function finishFailure(finish) {
  switch (finish.kind) {
    case 'stop':
      return undefined;
    case 'max-tokens':
      return failure(ERROR_CODES.MODEL_TRUNCATED);
    case 'aborted':
      return failure(ERROR_CODES.MODEL_TIMEOUT);
    case 'error':
      return failure(ERROR_CODES.MODEL_FAILED);
    default:
      // tool-calls or any future kind: not a text rewrite.
      return failure(ERROR_CODES.MODEL_FAILED);
  }
}

/**
 * Run one rewrite.
 *
 * @param input - text, resolved config, route, and the injected stream.
 * @param input.text - raw user text from the request body.
 * @param input.config - resolved plugin policy.
 * @param input.route - `{ provider, model, reasoningEffort? }`, or undefined.
 * @param input.stream - `(options) => AsyncIterable<StreamChunk>`, normally `ctx.llm.stream`.
 * @param input.signal - optional cancellation from the transport.
 * @param input.timeoutMs - optional override; defaults to the policy value.
 * @returns the wire envelope, never a thrown provider error.
 */
export async function runRewrite(input) {
  const text = normalizeText(input.text);
  if (text === '') return failure(ERROR_CODES.INVALID_INPUT);
  const mode = ['conservative', 'balanced', 'task'].includes(input.mode) ? input.mode : 'balanced';
  const feedback = normalizeText(input.feedback);
  if (exceedsInputLimit(text, input.config.maxInputLength)) {
    return failure(
      ERROR_CODES.INPUT_TOO_LONG,
      `输入过长（超过 ${input.config.maxInputLength} 字符），未调用模型`,
    );
  }
  if (input.route === undefined || input.route.provider === '' || input.route.model === '') {
    return failure(ERROR_CODES.MODEL_NOT_CONFIGURED);
  }

  const timeoutMs = input.timeoutMs ?? input.config.timeoutMs;
  const controller = new AbortController();
  const external = input.signal;
  let timedOut = false;

  if (external !== undefined && external.aborted) return failure(ERROR_CODES.MODEL_FAILED, '请求已取消');
  const onExternalAbort = () => controller.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const options = buildGenerateOptions({
      provider: input.route.provider,
      model: input.route.model,
      reasoningEffort: input.route.reasoningEffort,
      text,
      maxOutputTokens: input.config.maxOutputTokens,
      temperature: input.config.temperature,
      mode,
      feedback,
      signal: controller.signal,
    });

    const { text: collected, finish } = await readChunks(input.stream(options));
    if (timedOut) return failure(ERROR_CODES.MODEL_TIMEOUT);

    const terminal = finishFailure(finish);
    if (terminal !== undefined) return terminal;

    const result = collected.trim();
    if (result === '') return failure(ERROR_CODES.EMPTY_RESULT);
    return success(result);
  } catch {
    if (timedOut) return failure(ERROR_CODES.MODEL_TIMEOUT);
    if (external !== undefined && external.aborted) return failure(ERROR_CODES.MODEL_FAILED, '请求已取消');
    // Provider messages, status codes, and URLs stay in the host: the browser
    // gets one stable code and product copy.
    return failure(ERROR_CODES.MODEL_FAILED);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}
