import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codePointLength,
  DEFAULT_MAX_INPUT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  exceedsInputLimit,
  normalizeText,
  publicLimits,
  resolveConfig,
} from '../lib/config.js';

test('defaults are materialized for an absent config', () => {
  const resolved = resolveConfig(undefined);
  assert.equal(resolved.provider, undefined);
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(resolved.maxInputLength, DEFAULT_MAX_INPUT_LENGTH);
  assert.equal(resolved.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(resolved.temperature, DEFAULT_TEMPERATURE);
  assert.equal(resolved.enableButton, true);
  assert.ok(Object.isFrozen(resolved));
});

test('the row config overrides defaults', () => {
  const resolved = resolveConfig({
    provider: 'workbuddy',
    model: 'cn:deepseek-v4.1-flash',
    timeoutMs: 5000,
    maxInputLength: 120,
    maxOutputTokens: 80,
    temperature: 0,
    enableButton: false,
  });
  assert.equal(resolved.provider, 'workbuddy');
  assert.equal(resolved.model, 'cn:deepseek-v4.1-flash');
  assert.equal(resolved.timeoutMs, 5000);
  assert.equal(resolved.maxInputLength, 120);
  assert.equal(resolved.maxOutputTokens, 80);
  assert.equal(resolved.temperature, 0);
  assert.equal(resolved.enableButton, false);
});

test('invalid config fails activation loudly', () => {
  assert.throws(() => resolveConfig({ nonsense: 1 }), /unknown config key "nonsense"/);
  assert.throws(() => resolveConfig({ provider: 'p' }), /provider and model must be supplied together/);
  assert.throws(() => resolveConfig({ model: 'm' }), /provider and model must be supplied together/);
  assert.throws(() => resolveConfig({ provider: '', model: 'm' }), /provider must be a non-empty string/);
  assert.throws(() => resolveConfig({ provider: 'p', model: '' }), /model must be a non-empty string/);
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /timeoutMs must be an integer/);
  assert.throws(() => resolveConfig({ timeoutMs: 1.5 }), /timeoutMs must be an integer/);
  assert.throws(() => resolveConfig({ maxInputLength: -1 }), /maxInputLength must be an integer/);
  assert.throws(() => resolveConfig({ maxOutputTokens: 0 }), /maxOutputTokens must be an integer/);
  assert.throws(() => resolveConfig({ temperature: 3 }), /temperature must be a number between 0 and 2/);
  assert.throws(() => resolveConfig({ enableButton: 'yes' }), /enableButton must be a boolean/);
  assert.throws(() => resolveConfig({ timeoutMs: 2_147_483_648 }), /timeoutMs must be an integer/);
  assert.throws(() => resolveConfig([1]), /config must be an object/);
});

test('the client-facing policy carries no route, no provider, no credential', () => {
  const limits = publicLimits(resolveConfig({
    provider: 'workbuddy',
    model: 'cn:deepseek-v4.1-flash',
  }));
  assert.deepEqual({ ...limits }, { enableButton: true, maxInputLength: DEFAULT_MAX_INPUT_LENGTH });
  const serialized = JSON.stringify(limits);
  assert.ok(!serialized.includes('workbuddy'));
  assert.ok(!serialized.includes('deepseek'));
});

test('text normalization trims without editing content', () => {
  assert.equal(normalizeText('  你好，世界  '), '你好，世界');
  assert.equal(normalizeText('\n\tkeep  inner  spaces\n'), 'keep  inner  spaces');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(42), '');
  assert.equal(normalizeText(null), '');
});

test('code point counting treats one glyph as one character', () => {
  assert.equal(codePointLength('abc'), 3);
  assert.equal(codePointLength('中文'), 2);
  assert.equal(codePointLength('🙂'), 1);
  assert.equal(codePointLength('a🙂中'), 3);
});

test('the input limit is inclusive', () => {
  assert.equal(exceedsInputLimit('abcd', 4), false);
  assert.equal(exceedsInputLimit('abcde', 4), true);
  assert.equal(exceedsInputLimit('🙂🙂🙂', 3), false);
  assert.equal(exceedsInputLimit('🙂🙂🙂🙂', 3), true);
});
