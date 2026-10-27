import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../lib/config.js';
import { ERROR_CODES, runRewrite } from '../lib/rewrite.js';

const route = { provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash' };

/** A stream that never produces a chunk until its signal aborts. */
const hangingStream = (options) => (async function* hanging() {
  await new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (options.signal === undefined) return reject(new Error('no signal'));
    if (options.signal.aborted) return onAbort();
    options.signal.addEventListener('abort', onAbort, { once: true });
  });
})();

/** A stream that dies after the provider leaked its own diagnostics. */
const leakyStream = () => (async function* leaky() {
  yield { type: 'text-delta', index: 0, text: 'half' };
  throw new Error('401 Unauthorized: https://api.example.test/v1/chat key=sk-live-DEADBEEF');
})();

const config = resolveConfig({ timeoutMs: 30, maxInputLength: 100 });

test('a model timeout answers MODEL_TIMEOUT and produces no result', async () => {
  const startedAt = Date.now();
  const envelope = await runRewrite({
    text: '这是一段不能丢的原始输入',
    config,
    route,
    stream: hangingStream,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.MODEL_TIMEOUT);
  assert.equal(envelope.result, undefined);
  assert.ok(elapsed < 2_000, `timeout fired after ${elapsed}ms`);
  assert.match(envelope.error.message, /已保留原始输入/);
});

test('a caller cancellation answers without claiming a timeout', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const envelope = await runRewrite({
    text: '原始输入',
    config,
    route,
    stream: hangingStream,
    signal: controller.signal,
  });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.message, '请求已取消');
  assert.equal(envelope.result, undefined);
});

test('an already-aborted signal never calls the model', async () => {
  let called = 0;
  const controller = new AbortController();
  controller.abort();
  const envelope = await runRewrite({
    text: '原始输入',
    config,
    route,
    signal: controller.signal,
    stream: () => {
      called += 1;
      return (async function* empty() {})();
    },
  });
  assert.equal(envelope.ok, false);
  assert.equal(called, 0);
});

test('a provider error never leaks its message, URL, key, or the user text', async () => {
  const userText = '我的完整私人需求，不能被写进错误响应';
  const envelope = await runRewrite({
    text: userText,
    config: resolveConfig({ timeoutMs: 5_000 }),
    route,
    stream: leakyStream,
  });

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.MODEL_FAILED);

  const wire = JSON.stringify(envelope);
  assert.ok(!wire.includes('sk-live-DEADBEEF'), 'API key leaked');
  assert.ok(!wire.includes('api.example.test'), 'request URL leaked');
  assert.ok(!wire.includes('401'), 'provider status leaked');
  assert.ok(!wire.includes('Unauthorized'), 'provider message leaked');
  assert.ok(!wire.includes(userText), 'user input leaked');
  assert.ok(wire.includes('已保留原始输入'), 'product copy missing');
});

test('every failure keeps the caller able to keep the original text', async () => {
  const failures = [
    { text: '', stream: leakyStream, code: ERROR_CODES.INVALID_INPUT },
    { text: 'x'.repeat(101), stream: leakyStream, code: ERROR_CODES.INPUT_TOO_LONG },
    { text: 'ok', stream: leakyStream, code: ERROR_CODES.MODEL_FAILED },
    { text: 'ok', stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })(), code: ERROR_CODES.EMPTY_RESULT },
  ];

  for (const entry of failures) {
    const envelope = await runRewrite({
      text: entry.text,
      config,
      route,
      stream: entry.stream,
    });
    assert.equal(envelope.ok, false, entry.code);
    assert.equal(envelope.error.code, entry.code);
    // The contract the client half relies on: nothing to overwrite the draft with.
    assert.equal('result' in envelope, false);
  }
});

test('a rewrite does not mutate the input it was given', async () => {
  const input = {
    text: '  保留我  ',
    config,
    route,
    stream: async function* (options) {
      assert.equal(options.messages[0].content[0].text, '保留我');
      yield { type: 'text-delta', index: 0, text: '保留我，并补充输出格式。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const snapshot = JSON.stringify(input.text);
  const envelope = await runRewrite(input);
  assert.equal(envelope.ok, true);
  assert.equal(input.text, JSON.parse(snapshot));
});
