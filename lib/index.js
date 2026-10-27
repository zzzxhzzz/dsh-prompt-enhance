/**
 * Host half of the 增强提示词 (prompt-enhance) plugin.
 *
 * One Cordis function plugin exposes two exact routes on the composition's web
 * carrier and calls the composition's own LLM service — no second provider
 * client, no credential, no key in this package:
 *
 * | Route                              | Method | Purpose                              |
 * |------------------------------------|--------|--------------------------------------|
 * | `/api/prompt-enhance/config`       | GET    | policy the composer button may read  |
 * | `/api/prompt-enhance/rewrite`      | POST   | one rewrite, answered as an envelope |
 *
 * Both sit behind the composition's `connection` trust fence
 * (`requestRejection`), so Host/Origin checks and browser authentication gate
 * every caller before any work happens. The routes are removed with the plugin
 * fiber: each registration is installed through `ctx.effect`.
 *
 * The browser is told nothing it does not need: a failure carries a stable code
 * and product copy, while provider messages, request URLs, headers and the
 * user's text stay on this side.
 *
 * @module dsh-prompt-enhance
 */

import { normalizeText, publicLimits, resolveConfig } from './config.js';
import { ERROR_CODES, failure, runRewrite } from './rewrite.js';

/** Cordis plugin name (also the Loader row id used by the shipped patch). */
export const name = 'prompt-enhance';

/**
 * Hard dependencies. `webServer` carries the routes, `connection` is the trust
 * fence in front of them, `llm` is the composition's model-call registry. The
 * plugin stays inactive in a profile without them instead of throwing.
 */
export const inject = ['webServer', 'connection', 'llm'];

/** Policy route: limits the composer needs before the first click. */
export const CONFIG_ROUTE = '/api/prompt-enhance/config';

/** Rewrite route: one request in, one envelope out. */
export const REWRITE_ROUTE = '/api/prompt-enhance/rewrite';

/** Largest request body accepted, in bytes; the text limit is far below it. */
const MAX_BODY_BYTES = 64 * 1024;

/** Send one JSON payload with caching disabled. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Read one JSON body, refusing anything larger than {@link MAX_BODY_BYTES}.
 *
 * @param req - Node request stream.
 * @returns the parsed value.
 * @throws {Error} with `code` `BODY_TOO_LARGE` or `BAD_JSON`.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('bad json');
    error.code = 'BAD_JSON';
    throw error;
  }
}

/**
 * Resolve the model route for one call: the explicit pair from `config`, else
 * the composition's current default selection.
 *
 * @param ctx - host context.
 * @param resolved - resolved plugin policy.
 * @returns `{ provider, model, reasoningEffort? }`, or undefined when nothing is configured.
 */
function resolveRoute(ctx, resolved) {
  if (resolved.provider !== undefined && resolved.model !== undefined) {
    return { provider: resolved.provider, model: resolved.model };
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
  if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    };
  }
  return undefined;
}

/** Answer an untrusted or unauthenticated request; true when it was rejected. */
function rejectUntrusted(ctx, req, res) {
  let rejection;
  try {
    rejection = ctx.get('connection')?.requestRejection?.(req);
  } catch {
    rejection = 403;
  }
  if (rejection === undefined || rejection === null) return false;
  res.statusCode = typeof rejection === 'number' ? rejection : 403;
  res.end();
  return true;
}

/**
 * Register both routes for this profile.
 *
 * @param ctx - host context carrying `webServer`, `connection`, `llm`.
 * @param config - the row's raw configuration.
 * @throws {Error} when the configuration is invalid (activation fails loudly).
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: (req, res) => {
      if (rejectUntrusted(ctx, req, res)) return;
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
      }
      sendJson(res, 200, publicLimits(resolved));
    },
  }), 'prompt-enhance: GET config');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REWRITE_ROUTE,
    handler: async (req, res) => {
      if (rejectUntrusted(ctx, req, res)) return;
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const tooLarge = error?.code === 'BODY_TOO_LARGE';
        sendJson(res, tooLarge ? 413 : 400, failure(ERROR_CODES.INVALID_INPUT, '请求格式不正确'));
        return;
      }

      const text = normalizeText(body?.text);
      const mode = typeof body?.mode === 'string' ? body.mode : 'balanced';
      const feedback = normalizeText(body?.feedback);
      const route = resolveRoute(ctx, resolved);
      if (route === undefined) {
        sendJson(res, 200, failure(ERROR_CODES.MODEL_NOT_CONFIGURED));
        return;
      }

      const startedAt = Date.now();
      let envelope;
      try {
        envelope = await runRewrite({
          text,
          config: resolved,
          route,
          mode,
          feedback,
          stream: (options) => ctx.llm.stream(options),
          signal: undefined,
        });
      } catch {
        // runRewrite already converts provider failures; this is the last net.
        envelope = failure(ERROR_CODES.MODEL_FAILED);
      }

      if (!envelope.ok) {
        // Diagnostics stay deliberately opaque: code and elapsed time only.
        ctx.logger?.warn?.(`prompt-enhance: rewrite failed code=${envelope.error.code} elapsedMs=${Date.now() - startedAt}`);
      }
      sendJson(res, 200, envelope);
    },
  }), 'prompt-enhance: POST rewrite');

  ctx.logger?.info?.('prompt-enhance: routes registered');
}
