/* ---------- Telegram publish ---------- */

function sendOrderToGroup(order, fallbackTelegramChannel) {
  const token = getBotApiToken();
  if (!token) {
    return {
      ok: false,
      reason: 'token_not_set',
      error: isVkProvider() ? 'VK_BOT_TOKEN не задан' : 'TELEGRAM_BOT_TOKEN не задан'
    };
  }

  const chatId = resolveTelegramChat(order.customerCity, fallbackTelegramChannel);
  if (!chatId) {
    return {
      ok: false,
      reason: 'chat_not_set',
      error: isVkProvider() ? 'VK_CHAT_ID не задан' : 'TELEGRAM_CHAT_ID не задан'
    };
  }

  const briefText = generateBriefText(order);
  const callbackData = makeCallbackData(CALLBACK_ACTIONS.TAKE, order.orderId);

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ ВЫХОЖУ НА ЗАЯВКУ', callback_data: callbackData }
    ]]
  };

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chatId,
      text: briefText,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true
    })
  });

  if (!resp || resp.ok !== true || !resp.result) {
    Logger.log('sendOrderToGroup failed: ' + JSON.stringify(resp || null));
    return {
      ok: false,
      reason: 'telegram_error',
      error: (resp && (resp.description || resp.error || resp.note)) || 'Telegram sendMessage failed',
      telegram: resp || null
    };
  }

  return {
    ok: true,
    chatId: String(chatId),
    messageId: String(resp.result.message_id || '').trim(),
    telegram: resp
  };
}
