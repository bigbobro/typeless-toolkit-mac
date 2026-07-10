'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-public-account-'));
process.env.TYPELESS_DATA_DIR = DATA_DIR;

const { publicAccount, publicCapture, publicDictionary, publicLiveStatus, safeCount } = require('../manager');

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('公开账号 DTO 使用白名单,不会序列化 token 或未知敏感字段', () => {
  const view = publicAccount({
    user_id: 'u1', nickname: '甲', email: 'a@example.com', role: 'pro',
    token: 'secret-token', user_info: { secret: true }, internal_note: 'hidden',
    captured_at: '2026-07-10T00:00:00.000Z', added_at: '2026-07-10T00:00:00.000Z',
  }, { token_days_left: 30, token: 'must-not-pass-through' });

  assert.strictEqual(view.user_id, 'u1');
  assert.strictEqual(view.token_days_left, 30);
  assert.ok(!Object.hasOwn(view, 'token'));
  assert.ok(!Object.hasOwn(view, 'user_info'));
  assert.ok(!JSON.stringify(view).includes('secret-token'));
});

test('公开抓取 DTO 只含 capture_id 和展示字段', () => {
  const view = publicCapture({
    user_id: 'u1', nickname: '甲', email: 'a@example.com', role: 'pro',
    token: 'secret-token', user_info: { secret: true }, captured_at: 'now',
  }, 'capture-1');

  assert.deepStrictEqual(view, {
    capture_id: 'capture-1', user_id: 'u1', nickname: '甲',
    email: 'a@example.com', role: 'pro', captured_at: 'now',
  });
});

test('实时状态 DTO 丢弃远端未知字段和 user_info', () => {
  const view = publicLiveStatus({
    token_valid: true,
    usage: {
      week_word_usage_value: 12,
      week_word_usage_limit: 8000,
      total_words: 1234,
      total_audio_seconds: 567,
      mins_saved: 8,
      avg_wpm: 180,
      token: 'nested-usage-secret',
      unknown: { user_info: { token: 'deep-usage-secret' } },
    },
    personal: {
      total_learning_ratio: 0.25,
      enabled: true,
      category_stats: [{ token: 'nested-personal-secret' }, {}],
      user_info: { token: 'deep-personal-secret' },
    },
    dict_count: 2,
    user_info: { token: 'nested-secret' },
    token: 'top-level-secret',
  });
  assert.deepStrictEqual(view, {
    token_valid: true,
    usage: {
      week_word_usage_value: 12,
      week_word_usage_limit: 8000,
      total_words: 1234,
      total_audio_seconds: 567,
      mins_saved: 8,
      avg_wpm: 180,
    },
    personal: { total_learning_ratio: 0.25, enabled: true, category_count: 2 },
    dict_count: 2,
  });
  assert.ok(!JSON.stringify(view).includes('secret'));
  assert.ok(!Object.hasOwn(view.personal, 'category_stats'));
});

test('实时状态 DTO 把缺失或非有限数值归一为 null', () => {
  const view = publicLiveStatus({
    usage: {
      week_word_usage_value: Infinity,
      week_word_usage_limit: '8000',
      total_words: NaN,
    },
    personal: {
      total_learning_ratio: -Infinity,
      enabled: 'true',
      category_count: NaN,
    },
  });

  assert.deepStrictEqual(view.usage, {
    week_word_usage_value: null,
    week_word_usage_limit: null,
    total_words: null,
    total_audio_seconds: null,
    mins_saved: null,
    avg_wpm: null,
  });
  assert.deepStrictEqual(view.personal, {
    total_learning_ratio: null,
    enabled: false,
    category_count: null,
  });
});

test('词库 DTO 只下发 term 和布尔 auto', () => {
  const view = publicDictionary({
    words: [
      { term: 'hello', auto: true, token: 'secret', user_dictionary_id: 'internal-1' },
      { term: 'world', auto: false, user_info: { token: 'deep-secret' } },
      { term: 123, auto: true },
      null,
    ],
    token: 'top-secret',
    pagination: { cursor: 'private' },
  });

  assert.deepStrictEqual(view, {
    words: [
      { term: 'hello', auto: true },
      { term: 'world', auto: false },
    ],
  });
  assert.ok(!JSON.stringify(view).includes('secret'));
});

test('远端计数只接受非负安全整数', () => {
  assert.strictEqual(safeCount(3), 3);
  for (const value of [-1, 1.5, NaN, Infinity, '3', '<img src=x onerror=alert(1)>', null]) {
    assert.strictEqual(safeCount(value), 0);
  }
});
