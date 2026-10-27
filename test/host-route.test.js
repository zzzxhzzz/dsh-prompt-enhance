import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG_ROUTE, REWRITE_ROUTE, apply, inject, name } from '../lib/index.js';

/** Minimal Cordis-like host context that records what the plugin registers. */
function makeCtx(overrides = {}) {
  const routes = new Map();
  const effects = [];
  const disposers = [];
  const logs = [];
  const ctx = {
    effect(fn, label) {
      effects.push(label);
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    connection: { requestRejection: () => undefined },
    llm: { stream: () => (async function* () {})() },
    logger: {
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    },
  };
  ctx.get = (service) => {
    if (service === 'connection') return ctx.connection;
    if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash' }) };
    return undefined;
  };
  Object.assign(ctx, overrides);
  return { ctx, routes, effects, disposers, logs };
}

/** A Node-like request carrying one JSON body. */
function makeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** A Node-like response that records what the handler wrote. */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

const streamOf = (chunks) => async function* stream() {
  for (const chunk of chunks) yield chunk;
};

test('the plugin declares its identity and hard dependencies', () => {
  assert.equal(name, 'prompt-enhance');
  assert.deepEqual([...inject], ['webServer', 'connection', 'llm']);
  assert.equal(CONFIG_ROUTE, '/api/prompt-enhance/config');
  assert.equal(REWRITE_ROUTE, '/api/prompt-enhance/rewrite');
});

test('apply registers exactly two effect-owned routes', () => {
  const { ctx, routes, effects } = makeCtx();
  apply(ctx, { timeoutMs: 1000 });
  assert.deepEqual([...routes.keys()].sort(), [CONFIG_ROUTE, REWRITE_ROUTE].sort());
  assert.equal(effects.length, 2);
  assert.match(effects[0], /prompt-enhance/);
});

test('disposing the effects removes both routes (fiber unload)', () => {
  const { ctx, routes, disposers } = makeCtx();
  apply(ctx, {});
  assert.equal(routes.size, 2);
  assert.equal(disposers.length, 2);
  for (const dispose of disposers) dispose();
  assert.equal(routes.size, 0);
});

test('GET config answers the client policy and refuses other methods', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});

  const ok = makeRes();
  await routes.get(CONFIG_ROUTE).handler(makeReq('GET'), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { enableButton: true, maxInputLength: 4000 });

  const wrong = makeRes();
  await routes.get(CONFIG_ROUTE).handler(makeReq('POST'), wrong);
  assert.equal(wrong.statusCode, 405);
  assert.equal(wrong.headers.allow, 'GET');
});

test('an untrusted request is rejected before any work happens', async () => {
  let streamed = 0;
  const { ctx, routes } = makeCtx({
    connection: { requestRejection: () => 401 },
    llm: { stream: () => { streamed += 1; return streamOf([])(); } },
  });
  apply(ctx, {});

  const res = makeRes();
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', JSON.stringify({ text: '你好' })), res);
  assert.equal(res.statusCode, 401);
  assert.equal(streamed, 0);
});

test('POST rewrite returns the rewritten prompt for a good request', async () => {
  const { ctx, routes } = makeCtx({
    llm: {
      stream: streamOf([
        { type: 'text-delta', index: 0, text: '请把需求改写成' },
        { type: 'text-delta', index: 0, text: '三条验收标准。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    },
  });
  apply(ctx, {});

  const res = makeRes();
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', JSON.stringify({ text: '  帮我写清楚  ' })), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, result: '请把需求改写成三条验收标准。' });
});

test('a malformed body is a 400 envelope, not a crash', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});

  const res = makeRes();
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', '{not json'), res);
  assert.equal(res.statusCode, 400);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INVALID_INPUT');
});

test('an oversized body is refused without calling the model', async () => {
  let streamed = 0;
  const { ctx, routes } = makeCtx({ llm: { stream: () => { streamed += 1; return streamOf([])(); } } });
  apply(ctx, {});

  const res = makeRes();
  const huge = JSON.stringify({ text: 'x'.repeat(70 * 1024) });
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', huge), res);
  assert.equal(res.statusCode, 413);
  assert.equal(streamed, 0);
});

test('an empty input never reaches the model', async () => {
  let streamed = 0;
  const { ctx, routes } = makeCtx({ llm: { stream: () => { streamed += 1; return streamOf([])(); } } });
  apply(ctx, { maxInputLength: 10 });
  const res = makeRes();
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', JSON.stringify({ text: '   ' })), res);
  assert.equal(streamed, 0);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INVALID_INPUT');
});

test('an over-limit input is refused with the configured number', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, { maxInputLength: 5 });

  const res = makeRes();
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', JSON.stringify({ text: '123456' })), res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INPUT_TOO_LONG');
  assert.match(payload.error.message, /超过 5 字符/);
});

test('a provider failure logs the code only and leaks nothing to the browser', async () => {
  const secret = 'sk-live-DEADBEEF';
  const { ctx, routes, logs } = makeCtx({
    llm: {
      stream: () => {
        throw new Error(`Unauthorized: https://api.example.test/v1 key=${secret}`);
      },
    },
  });
  apply(ctx, {});

  const res = makeRes();
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', JSON.stringify({ text: '我的私人需求' })), res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'MODEL_FAILED');

  const wire = res.body;
  assert.ok(!wire.includes(secret));
  assert.ok(!wire.includes('api.example.test'));
  assert.ok(!wire.includes('我的私人需求'));

  const logText = logs.join('\n');
  assert.match(logText, /code=MODEL_FAILED/);
  assert.ok(!logText.includes(secret));
  assert.ok(!logText.includes('api.example.test'));
  assert.ok(!logText.includes('我的私人需求'));
});

test('the model route falls back to the composition default selection', async () => {
  let seen;
  const { ctx, routes } = makeCtx({
    llm: {
      stream: (options) => {
        seen = options;
        return streamOf([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }])();
      },
    },
  });
  apply(ctx, {});
  const res = makeRes();
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', JSON.stringify({ text: '你好' })), res);

  assert.equal(seen.provider, 'workbuddy');
  assert.equal(seen.model, 'cn:deepseek-v4.1-flash');
  assert.match(seen.system, /提示词优化器/);
});

test('no configuration means no route, and that is reported not guessed', async () => {
  let streamed = 0;
  const { ctx, routes } = makeCtx({
    get: () => undefined,
    llm: { stream: () => { streamed += 1; return streamOf([])(); } },
  });
  apply(ctx, {});
  const res = makeRes();
  await routes.get(REWRITE_ROUTE).handler(makeReq('POST', JSON.stringify({ text: '你好' })), res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(streamed, 0);
});
