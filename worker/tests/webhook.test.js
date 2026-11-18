import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { douyinUrl, TelegramAllowlist } from '../index.js';
const env = { TELEGRAM_WEBHOOK_SECRET: 'test-secret', TELEGRAM_ALLOWED_USER_IDS: '42', GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF: 'feature/test', GITHUB_WORKFLOW: 'transcribe.yml', GITHUB_DISPATCH_TOKEN: 'fake', TELEGRAM_BOT_TOKEN: 'fake' };
function request(body, secret = 'test-secret', path = '/telegram') {
  return new Request(`https://example.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) });
}
const update = { update_id: 123, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '复制 https://v.douyin.com/abc/ 打开抖音' } };
test('accepts only independent Douyin links', () => {
  assert.equal(douyinUrl(update.message.text), 'https://v.douyin.com/abc/');
  for (const value of ['https://bilibili.com/video/1', 'https://evildouyin.com/video/1', 'https://evil.test/v.douyin.com/x/']) assert.equal(douyinUrl(value), null);
});
test('rejects invalid webhook secret', async () => { assert.equal((await worker.fetch(request(update, 'wrong'), env)).status, 403); });
test('ignores unauthorized users and groups before making requests', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw Error('must not call network'); };
  try {
    const denied = structuredClone(update); denied.message.from.id = 7;
    assert.equal((await worker.fetch(request(denied), env)).status, 200);
    const group = structuredClone(update); group.message.chat.type = 'group';
    assert.equal((await worker.fetch(request(group), env)).status, 200);
  } finally { globalThis.fetch = original; }
});
test('dispatches a workflow with data inputs and reports acceptance', async () => {
  const calls = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 204 }); };
  try {
    assert.equal((await worker.fetch(request(update), env)).status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /workflows\/transcribe.yml\/dispatches$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), { ref: 'feature/test', inputs: { url: 'https://v.douyin.com/abc/', chat_id: '42', request_id: '123' } });
  } finally { globalThis.fetch = original; }
});
test('dispatch failure produces an actionable retry response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => new Response(null, { status: url.includes('api.github.com') ? 403 : 200 });
  try { assert.equal((await worker.fetch(request(update), env)).status, 502); } finally { globalThis.fetch = original; }
});

test('only the owner can change the allowlist and CI shares its authorization', async t => {
  const users = new Map();
  const object = new TelegramAllowlist({ storage: {
    get: id => users.get(id),
    put: (id, value) => users.set(id, value),
    delete: id => users.delete(id),
    list: () => users,
  } });
  const config = { ...env, TELEGRAM_ALLOWLIST: {
    getByName: () => ({ fetch: (url, options) => object.fetch(new Request(url, options)) }),
  } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    calls.push({ url, body: JSON.parse(body) });
    return new Response(null, { status: 204 });
  });
  const send = (id, text) => worker.fetch(request({
    update_id: 123,
    message: { from: { id }, chat: { id, type: 'private' }, text },
  }), config);
  const authorize = (id, secret) => worker.fetch(request({ chat_id: id }, secret, '/telegram/authorize'), config);
  const lastReply = () => calls.at(-1).body.text;

  assert.equal((await authorize('42')).status, 204);
  assert.equal((await authorize('7')).status, 403);
  assert.equal((await authorize('42', 'wrong')).status, 403);
  assert.equal((await authorize('0007')).status, 400);
  await send(7, update.message.text);
  await send(7, '/allow 7');
  assert.equal(calls.length, 0);
  await send(42, '/allowlist');
  assert.equal(lastReply(), '白名单（共 1 人）\n42（管理员）');

  await send(42, '/allow 7');
  await send(42, '/allow 7');
  await send(42, '/allowlist');
  assert.equal(lastReply(), '白名单（共 2 人）\n42（管理员）\n7');
  assert.equal((await authorize('7')).status, 204);
  await send(7, '/allow 8');
  assert.equal(lastReply(), '只有管理员可以管理白名单。');
  assert.equal((await authorize('8')).status, 403);
  await send(7, update.message.text);
  const dispatch = calls.find(call => call.url.includes('api.github.com'));
  assert.equal(dispatch.body.inputs.chat_id, '7');

  await send(42, '/deny 42');
  assert.equal((await authorize('42')).status, 204);
  await send(42, '/deny 7');
  assert.equal(lastReply(), '已删除 7 的使用权限。');
  assert.equal((await authorize('7')).status, 403);
  await send(42, '/deny 7');
  assert.equal(lastReply(), '7 不在白名单中。');
  const count = calls.length;
  await send(7, update.message.text);
  assert.equal(calls.length, count);
});
