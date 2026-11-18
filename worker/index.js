export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || (path !== '/telegram' && path !== '/telegram/authorize')) {
      return new Response('Not found', { status: 404 });
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    let payload;
    try { payload = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
    const owner = (env.TELEGRAM_ALLOWED_USER_IDS || '').trim();
    if (path === '/telegram/authorize') {
      const id = payload?.chat_id;
      if (!isUserId(id)) return new Response('Bad request', { status: 400 });
      return new Response(null, { status: await isAllowed(env, owner, id) ? 204 : 403 });
    }

    const message = payload?.message;
    const sender = message?.from?.id;
    if (!Number.isSafeInteger(payload?.update_id) || !Number.isSafeInteger(sender) || sender < 1
        || message.chat?.type !== 'private' || message.chat.id !== sender) {
      return new Response('ok');
    }
    const id = String(sender);
    if (!await isAllowed(env, owner, id)) return new Response('ok');

    const text = typeof message.text === 'string' ? message.text : '';
    const [command, ...args] = text.trim().split(/\s+/);
    if (['/allow', '/deny', '/allowlist'].includes(command)) {
      if (id === owner) await manageAllowlist(env, id, command, args);
      else await notify(env, id, '只有管理员可以管理白名单。');
      return new Response('ok');
    }
    if (text === '/start' || text === '/help') {
      const help = '把抖音视频的分享链接发给我，GitHub Actions 会转成文字，并把 TXT、SRT 和时间戳 JSON 发回来。';
      const adminHelp = '\n\n管理员指令\n/allow 用户ID  添加用户\n/deny 用户ID  删除用户\n/allowlist  查看名单';
      await notify(env, id, id === owner ? help + adminHelp : help);
      return new Response('ok');
    }
    const url = douyinUrl(text);
    if (!url) {
      await notify(env, message.chat.id, '请发送抖音视频分享链接，也可以直接粘贴整段分享文字。');
      return new Response('ok');
    }
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'douyin-transcriber-webhook' },
      body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { url, chat_id: id, request_id: String(payload.update_id) } }),
    });
    if (!response.ok) {
      await notify(env, message.chat.id, 'CI 暂时无法启动，请稍后重发。');
      return new Response('Dispatch failed', { status: 502 });
    }
    await notify(env, message.chat.id, '已交给远端 CI，完成后会在这里发回文字稿。');
    return new Response('ok');
  },
};

function isUserId(id) {
  return typeof id === 'string' && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
}

async function isAllowed(env, owner, id) {
  if (id === owner) return true;
  const response = await allowlist(env).fetch(`https://allowlist/${id}`);
  return response.status === 204;
}

function allowlist(env) {
  return env.TELEGRAM_ALLOWLIST.getByName('users');
}

async function manageAllowlist(env, owner, command, args) {
  if (command === '/allowlist') {
    if (args.length) {
      await notify(env, owner, '用法 /allowlist');
      return;
    }
    const response = await allowlist(env).fetch('https://allowlist/');
    const users = await response.json();
    const entries = [`${owner}（管理员）`, ...users];
    for (let offset = 0; offset < entries.length; offset += 200) {
      await notify(env, owner, `白名单（共 ${entries.length} 人）\n${entries.slice(offset, offset + 200).join('\n')}`);
    }
    return;
  }

  const [user] = args;
  if (args.length !== 1 || !isUserId(user)) {
    await notify(env, owner, `用法 ${command} 数字用户ID`);
    return;
  }
  if (user === owner) {
    await notify(env, owner, '管理员始终在白名单中。');
    return;
  }

  const adding = command === '/allow';
  const response = await allowlist(env).fetch(`https://allowlist/${user}`, { method: adding ? 'PUT' : 'DELETE' });
  if (!response.ok && response.status !== 404) throw Error('白名单更新失败');
  const result = adding ? `已允许 ${user} 使用机器人。` : `已删除 ${user} 的使用权限。`;
  await notify(env, owner, response.status === 404 ? `${user} 不在白名单中。` : result);
}

export class TelegramAllowlist {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const id = new URL(request.url).pathname.slice(1);
    if (request.method === 'PUT') {
      await this.storage.put(id, true);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'DELETE') {
      const removed = await this.storage.delete(id);
      return new Response(null, { status: removed ? 204 : 404 });
    }
    if (!id) {
      const users = await this.storage.list();
      return Response.json([...users.keys()]);
    }
    return new Response(null, { status: await this.storage.get(id) ? 204 : 404 });
  }
}

export function douyinUrl(text) {
  const match = text.match(/(?:https?:\/\/)?(?:(?:www\.|v\.)?douyin\.com|(?:www\.)?iesdouyin\.com)\/[^\s<>"“”\u4e00-\u9fff]+/i);
  if (!match || (match.index > 0 && /[a-z0-9./@_-]/i.test(text[match.index - 1]))) return null;
  const raw = match[0].replace(/[。，！？；）)】\]》]+$/, '');
  const url = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`);
  const hosts = ['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'];
  if (!hosts.includes(url.hostname) || url.username || url.password || url.port) return null;
  url.hash = '';
  return url.href;
}

async function notify(env, chat, text) {
  try {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }),
  });
  return response.ok;
  } catch { return false; }
}
