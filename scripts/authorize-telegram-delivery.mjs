const { TELEGRAM_CHAT_ID: chat, TELEGRAM_ALLOWED_USER_IDS: owner, TELEGRAM_WEBHOOK_SECRET: secret } = process.env;

if (!/^[1-9]\d*$/.test(chat || '') || !Number.isSafeInteger(Number(chat))) {
  throw Error('Telegram 聊天 ID 无效');
}

if (chat !== owner?.trim()) {
  if (!secret) throw Error('缺少 Telegram 白名单校验密钥');
  const response = await fetch('https://douyin-transcriber-webhook.f1515xcn.workers.dev/telegram/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ chat_id: chat }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 204) throw Error(`Telegram 白名单未授权交付（HTTP ${response.status}）`);
}

process.stdout.write(chat);
