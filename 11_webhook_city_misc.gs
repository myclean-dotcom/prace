/* ---------- Webhook routing ---------- */

function normalizeWebhookUrlToExec(url) {
  const value = String(url || '').trim();
  if (!value) return '';

  // Keep final googleusercontent webhook targets intact (contains required query params).
  if (value.indexOf('script.googleusercontent.com/macros/echo') !== -1) {
    return value;
  }

  const clean = value.replace(/\/$/, '');
  if (clean.indexOf('/exec') !== -1) return clean.replace(/\/exec(?:[?#].*)?$/, '/exec');
  if (clean.indexOf('/dev') !== -1) return clean.replace(/\/dev(?:[?#].*)?$/, '/exec');
  return clean;
}

function isGoogleLoginUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  if (!value) return false;
  return (
    value.indexOf('https://accounts.google.com/') === 0 ||
    value.indexOf('accounts.google.com/servicelogin') !== -1 ||
    value.indexOf('accounts.google.com/v3/signin') !== -1
  );
}

function isUsableWebhookTarget(url) {
  const value = normalizeWebhookUrlToExec(url);
  if (!value) return false;
  if (isGoogleLoginUrl(value)) return false;
  return /^https:\/\//i.test(value);
}

function getCurrentServiceExecUrl() {
  try {
    return normalizeWebhookUrlToExec(ScriptApp.getService().getUrl());
  } catch (err) {
    return '';
  }
}

function resolveWebhookExecUrl(preferredUrl) {
  const preferred = normalizeWebhookUrlToExec(preferredUrl);
  if (preferred && isUsableWebhookTarget(preferred)) return preferred;

  const stored = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  if (stored && isUsableWebhookTarget(stored)) return stored;

  const service = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (service && isUsableWebhookTarget(service)) return service;

  return '';
}

function getHeaderValue(headers, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!headers || !wanted) return '';
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (String(key || '').toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) {
      return String(value.length ? value[0] : '').trim();
    }
    return String(value || '').trim();
  }
  return '';
}

function probeWebhookRedirectTarget(url, method) {
  const targetUrl = normalizeWebhookUrlToExec(url);
  if (!targetUrl) {
    return { ok: false, url: '', method: 'get', statusCode: 0, redirectUrl: '', error: 'empty url' };
  }

  const httpMethod = String(method || 'get').toLowerCase() === 'post' ? 'post' : 'get';
  const params = {
    method: httpMethod,
    muteHttpExceptions: true,
    followRedirects: false
  };

  if (httpMethod === 'post') {
    params.contentType = 'application/x-www-form-urlencoded; charset=UTF-8';
    params.payload = 'action=probe_version';
  }

  try {
    const resp = UrlFetchApp.fetch(targetUrl, params);
    const headers = resp.getAllHeaders ? resp.getAllHeaders() : {};
    const location = getHeaderValue(headers, 'location');
    return {
      ok: true,
      url: targetUrl,
      method: httpMethod,
      statusCode: resp.getResponseCode(),
      redirectUrl: location
    };
  } catch (err) {
    return {
      ok: false,
      url: targetUrl,
      method: httpMethod,
      statusCode: 0,
      redirectUrl: '',
      error: err.message
    };
  }
}

function resolveTelegramWebhookTarget(execUrl) {
  const baseExecUrl = normalizeWebhookUrlToExec(execUrl);
  if (!baseExecUrl) return { targetUrl: '', redirectProbe: null, redirectProbeGet: null };

  // Telegram sends POST updates, so detect redirect target with POST first.
  const postProbe = probeWebhookRedirectTarget(baseExecUrl, 'post');
  const postTargetRaw = normalizeWebhookUrlToExec(postProbe && postProbe.redirectUrl ? postProbe.redirectUrl : '');
  const postTarget = isUsableWebhookTarget(postTargetRaw) ? postTargetRaw : '';

  let getProbe = null;
  let getTargetRaw = '';
  let getTarget = '';
  if (!postTarget) {
    getProbe = probeWebhookRedirectTarget(baseExecUrl, 'get');
    getTargetRaw = normalizeWebhookUrlToExec(getProbe && getProbe.redirectUrl ? getProbe.redirectUrl : '');
    getTarget = isUsableWebhookTarget(getTargetRaw) ? getTargetRaw : '';
  }

  const authBlocked =
    isGoogleLoginUrl(postTargetRaw) ||
    isGoogleLoginUrl(getTargetRaw) ||
    (postProbe && (Number(postProbe.statusCode || 0) === 401 || Number(postProbe.statusCode || 0) === 403)) ||
    (getProbe && (Number(getProbe.statusCode || 0) === 401 || Number(getProbe.statusCode || 0) === 403));

  const targetUrl = postTarget || getTarget || baseExecUrl;

  return {
    targetUrl: targetUrl,
    redirectProbe: postProbe,
    redirectProbeGet: getProbe,
    rejectedPostTarget: postTargetRaw && !postTarget ? postTargetRaw : '',
    rejectedGetTarget: getTargetRaw && !getTarget ? getTargetRaw : '',
    authBlocked: authBlocked
  };
}

function webhookUrlsEquivalent(currentUrl, expectedUrl) {
  const current = normalizeWebhookUrlToExec(currentUrl);
  const expected = normalizeWebhookUrlToExec(expectedUrl);
  if (!current || !expected) return current === expected;
  return current === expected;
}

function ensureWebhookBoundToCurrentExec(force) {
  if (isVkProvider()) {
    const baseExecUrl = resolveWebhookExecUrl('');
    if (baseExecUrl) {
      PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, baseExecUrl);
      PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(Date.now()));
    }
    return {
      ok: true,
      skipped: true,
      provider: 'vk',
      reason: 'vk_callback_api_uses_manual_server_binding',
      baseExecUrl: baseExecUrl || ''
    };
  }

  const token = getBotApiToken();
  if (!token) return { ok: false, reason: 'token_not_set' };

  const baseExecUrl = resolveWebhookExecUrl('');
  if (!baseExecUrl) return { ok: false, reason: 'exec_url_not_set' };
  const targetInfo = resolveTelegramWebhookTarget(baseExecUrl);
  const targetUrl = targetInfo && targetInfo.targetUrl ? targetInfo.targetUrl : baseExecUrl;
  if (!isUsableWebhookTarget(targetUrl)) {
    return { ok: false, reason: 'invalid_webhook_target', baseExecUrl: baseExecUrl, targetUrl: targetUrl };
  }
  if (targetInfo && targetInfo.authBlocked) {
    return {
      ok: false,
      reason: 'webapp_requires_auth',
      baseExecUrl: baseExecUrl,
      targetUrl: targetUrl,
      redirectProbe: targetInfo.redirectProbe || null,
      redirectProbeGet: targetInfo.redirectProbeGet || null
    };
  }

  const now = Date.now();
  const lastSync = Number(PROP.getProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY) || '0');
  if (!force && lastSync > 0 && (now - lastSync) < 3 * 60 * 1000) {
    return { ok: true, skipped: true, baseExecUrl: baseExecUrl, targetUrl: targetUrl };
  }

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
  const currentUrl = info && info.result && info.result.url
    ? normalizeWebhookUrlToExec(info.result.url)
    : '';

  if (!webhookUrlsEquivalent(currentUrl, targetUrl)) {
    const setResp = urlFetchJson(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'post',
      payload: JSON.stringify({
        url: targetUrl,
        allowed_updates: ['message', 'edited_message', 'callback_query']
      })
    });

    if (!setResp || setResp.ok !== true) {
      return { ok: false, reason: 'set_webhook_failed', telegram: setResp || null, targetUrl: targetUrl };
    }
  }

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, baseExecUrl);
  PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(now));

  return {
    ok: true,
    baseExecUrl: baseExecUrl,
    targetUrl: targetUrl,
    redirectProbe: targetInfo ? targetInfo.redirectProbe : null,
    redirectProbeGet: targetInfo ? targetInfo.redirectProbeGet : null,
    currentWebhookUrl: currentUrl,
    changed: !webhookUrlsEquivalent(currentUrl, targetUrl)
  };
}

/* ---------- City/chat resolve ---------- */

function normalizeCityKey(city) {
  return String(city || '').trim().toLowerCase();
}

function resolveTelegramChat(city, fallbackTelegramChannel) {
  const cityKey = normalizeCityKey(city);
  const map = isVkProvider()
    ? {
      'новосибирск': String(PROP.getProperty('VK_CHAT_NOVOSIBIRSK') || PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim()
    }
    : {
      'новосибирск': String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim()
    };

  const cityChat = String(map[cityKey] || '').trim();
  const fallback = isVkProvider()
    ? String(fallbackTelegramChannel || PROP.getProperty('VK_CHAT_ID') || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim()
    : String(fallbackTelegramChannel || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  return String(cityChat || fallback || '').trim();
}

/* ---------- Misc helpers ---------- */

function buildMasterName(from) {
  const first = String(from && from.first_name || '').trim();
  const last = String(from && from.last_name || '').trim();
  const username = String(from && from.username || '').trim();

  const full = (first + ' ' + last).trim();
  if (full) return full;
  if (username) return '@' + username;
  return 'Мастер';
}

function normalizeCustomerName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.split(/\s+/)[0];
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tryParseJson(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function textResponse(text) {
  return ContentService
    .createTextOutput(String(text || ''))
    .setMimeType(ContentService.MimeType.TEXT);
}

function handleVkCallbackEnvelope(body) {
  const type = String(body && body.type || '').trim().toLowerCase();
  if (!type) return textResponse('ok');

  if (type === 'confirmation') {
    const code = String(PROP.getProperty('VK_CONFIRMATION_CODE') || '').trim();
    if (!code) {
      Logger.log('VK confirmation requested, but VK_CONFIRMATION_CODE is empty');
      return textResponse('ok');
    }
    return textResponse(code);
  }

  const expectedSecret = String(PROP.getProperty('VK_CALLBACK_SECRET') || '').trim();
  if (expectedSecret) {
    const incomingSecret = String(body.secret || '').trim();
    if (incomingSecret !== expectedSecret) {
      Logger.log('VK callback ignored: secret mismatch');
      return textResponse('ok');
    }
  }

  if (type === 'message_event') {
    const callback = convertVkEventToTelegramCallback(body.object || {});
    if (callback) {
      try {
        handleTelegramUpdate({ callback_query: callback });
      } catch (err) {
        Logger.log('VK callback_query handling error: ' + err.message);
      }
    }
    return textResponse('ok');
  }

  if (type === 'message_new' || type === 'message_reply' || type === 'message_edit') {
    const msgObj = extractVkMessageObject(body.object || {});
    if (!msgObj || Number(msgObj.out || 0) === 1) {
      return textResponse('ok');
    }
    const message = convertVkMessageToTelegramMessage(msgObj);
    if (message) {
      try {
        handleTelegramUpdate({ message: message });
      } catch (err) {
        Logger.log('VK message handling error: ' + err.message);
      }
    }
    return textResponse('ok');
  }

  return textResponse('ok');
}

function extractVkMessageObject(object) {
  if (!object || typeof object !== 'object') return null;
  if (object.message && typeof object.message === 'object') return object.message;
  return object;
}

function convertVkMessageToTelegramMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;

  const fromId = String(msg.from_id || msg.sender_id || msg.user_id || '').trim();
  const peerId = String(msg.peer_id || fromId || '').trim();
  if (!fromId || !peerId) return null;

  const out = {
    message_id: String(msg.conversation_message_id || msg.message_id || msg.id || '').trim(),
    date: Number(msg.date || Math.floor(Date.now() / 1000)),
    text: String(msg.text || '').trim(),
    caption: String(msg.text || '').trim(),
    from: { id: fromId },
    chat: { id: peerId }
  };

  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const photos = [];
  let doc = null;

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i] || {};
    if (String(att.type || '').trim() === 'photo') {
      const fileId = buildVkAttachmentId('photo', att.photo || {});
      if (fileId) photos.push({ file_id: fileId });
    } else if (String(att.type || '').trim() === 'doc') {
      const fileIdDoc = buildVkAttachmentId('doc', att.doc || {});
      if (fileIdDoc && !doc) doc = { file_id: fileIdDoc };
    }
  }

  if (!photos.length && msg.photo && typeof msg.photo === 'object') {
    const singlePhotoId = buildVkAttachmentId('photo', msg.photo);
    if (singlePhotoId) photos.push({ file_id: singlePhotoId });
  }
  if (!doc && msg.doc && typeof msg.doc === 'object') {
    const singleDocId = buildVkAttachmentId('doc', msg.doc);
    if (singleDocId) doc = { file_id: singleDocId };
  }

  if (photos.length) out.photo = photos;
  if (doc) out.document = doc;

  return out;
}

function buildVkAttachmentId(type, item) {
  const kind = String(type || '').trim();
  const entity = item && typeof item === 'object' ? item : {};
  const ownerId = String(entity.owner_id || '').trim();
  const id = String(entity.id || '').trim();
  if (!kind || !ownerId || !id) return '';
  const accessKey = String(entity.access_key || '').trim();
  return kind + ownerId + '_' + id + (accessKey ? ('_' + accessKey) : '');
}

function convertVkEventToTelegramCallback(event) {
  if (!event || typeof event !== 'object') return null;

  const peerId = String(event.peer_id || '').trim();
  const userId = String(event.user_id || '').trim();
  if (!peerId || !userId) return null;

  const callbackData = extractVkCallbackData(event.payload);
  const callbackId = JSON.stringify({
    vk: 1,
    event_id: String(event.event_id || '').trim(),
    peer_id: peerId,
    user_id: userId
  });

  return {
    id: callbackId,
    data: callbackData,
    from: { id: userId },
    message: {
      chat: { id: peerId },
      message_id: String(event.conversation_message_id || event.message_id || '').trim()
    }
  };
}

function extractVkCallbackData(payload) {
  if (payload === null || payload === undefined) return '';

  if (typeof payload === 'string') {
    const raw = String(payload).trim();
    if (!raw) return '';
    const parsed = tryParseJson(raw);
    if (parsed && typeof parsed === 'object') return extractVkCallbackData(parsed);
    return raw;
  }

  if (typeof payload === 'object') {
    if (payload.callback_data) return String(payload.callback_data).trim();
    if (payload.data) return String(payload.data).trim();
    if (payload.payload) return String(payload.payload).trim();
    if (payload.action && payload.orderId) {
      const action = String(payload.action || '').trim().toLowerCase();
      const orderId = normalizeOrderId(payload.orderId);
      if (action && orderId) return action + ':' + orderId;
    }
    try {
      return JSON.stringify(payload);
    } catch (err) {
      return '';
    }
  }

  return String(payload || '').trim();
}

function isTelegramApiUrl(url) {
  const value = String(url || '').trim();
  return /^https:\/\/api\.telegram\.org\/bot[^/]+\/[A-Za-z0-9_]+/i.test(value);
}

function extractTelegramMethodName(url) {
  const value = String(url || '').trim();
  const m = value.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/([A-Za-z0-9_]+)/i);
  return m && m[1] ? String(m[1]).trim() : '';
}

function parseRequestPayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  const text = String(payload || '').trim();
  if (!text) return {};
  const parsed = tryParseJson(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function normalizeVkPeerId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^-?\d+$/.test(raw)) return raw;
  return '';
}

function vkApiCall(method, params) {
  const token = getBotApiToken();
  if (!token) return { ok: false, error: 'VK_BOT_TOKEN не задан', description: 'VK_BOT_TOKEN не задан', vk: null };

  const req = Object.assign({}, params || {}, {
    access_token: token,
    v: String(PROP.getProperty('VK_API_VERSION') || '5.199').trim()
  });

  const resp = UrlFetchApp.fetch('https://api.vk.com/method/' + method, {
    method: 'post',
    payload: req,
    muteHttpExceptions: true
  });
  const text = resp.getContentText();
  const json = tryParseJson(text);

  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'non_json_vk_response', description: 'VK non-json response', vk: { raw: text } };
  }

  if (json.error) {
    return {
      ok: false,
      error: String(json.error.error_msg || json.error.error_code || 'vk_error'),
      description: String(json.error.error_msg || 'VK API error'),
      errorCode: Number(json.error.error_code || 0),
      vk: json
    };
  }

  return { ok: true, result: json.response, vk: json };
}

function vkErrorAsTelegram(err, fallbackText) {
  return {
    ok: false,
    description: String((err && (err.description || err.error)) || fallbackText || 'VK API error'),
    vk: err && err.vk ? err.vk : null
  };
}

function convertTelegramReplyMarkupToVkKeyboard(replyMarkup) {
  if (!replyMarkup || typeof replyMarkup !== 'object') return '';

  if (replyMarkup.remove_keyboard) {
    return JSON.stringify({ buttons: [] });
  }

  if (Array.isArray(replyMarkup.inline_keyboard)) {
    const rowsInline = [];
    for (let i = 0; i < replyMarkup.inline_keyboard.length; i++) {
      const row = Array.isArray(replyMarkup.inline_keyboard[i]) ? replyMarkup.inline_keyboard[i] : [];
      const outRow = [];
      for (let j = 0; j < row.length; j++) {
        const btn = row[j] || {};
        const label = String(btn.text || '').trim();
        if (!label) continue;

        if (btn.url) {
          outRow.push({
            action: {
              type: 'open_link',
              link: String(btn.url || '').trim(),
              label: label
            }
          });
          continue;
        }

        outRow.push({
          action: {
            type: 'callback',
            label: label,
            payload: JSON.stringify({ callback_data: String(btn.callback_data || '') })
          },
          color: 'primary'
        });
      }
      if (outRow.length) rowsInline.push(outRow);
    }
    return rowsInline.length ? JSON.stringify({ inline: true, buttons: rowsInline }) : '';
  }

  if (Array.isArray(replyMarkup.keyboard)) {
    const rows = [];
    for (let i = 0; i < replyMarkup.keyboard.length; i++) {
      const rowRaw = Array.isArray(replyMarkup.keyboard[i]) ? replyMarkup.keyboard[i] : [];
      const rowOut = [];
      for (let j = 0; j < rowRaw.length; j++) {
        const item = rowRaw[j];
        const label = typeof item === 'string'
          ? String(item).trim()
          : String((item && (item.text || item.label)) || '').trim();
        if (!label) continue;

        const payloadRaw = (item && typeof item === 'object' && item.payload)
          ? item.payload
          : JSON.stringify({ command: label });

        rowOut.push({
          action: {
            type: 'text',
            label: label,
            payload: typeof payloadRaw === 'string' ? payloadRaw : JSON.stringify(payloadRaw)
          },
          color: 'secondary'
        });
      }
      if (rowOut.length) rows.push(rowOut);
    }
    return rows.length
      ? JSON.stringify({
        one_time: !!replyMarkup.one_time_keyboard,
        buttons: rows
      })
      : '';
  }

  return '';
}

function normalizeVkSendResult(result, peerId) {
  let messageId = '';
  if (typeof result === 'number' || typeof result === 'string') {
    messageId = String(result).trim();
  } else if (result && typeof result === 'object') {
    messageId = String(result.conversation_message_id || result.message_id || result.id || '').trim();
  }
  return {
    message_id: messageId || String(Date.now()),
    chat: { id: String(peerId || '') }
  };
}

function parseVkCallbackQueryId(callbackId) {
  const raw = String(callbackId || '').trim();
  if (!raw) return null;
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const eventId = String(parsed.event_id || '').trim();
  const userId = String(parsed.user_id || '').trim();
  const peerId = String(parsed.peer_id || '').trim();
  if (!eventId || !userId || !peerId) return null;
  return { eventId: eventId, userId: userId, peerId: peerId };
}

function routeTelegramMethodToVk(telegramMethod, payload) {
  const method = String(telegramMethod || '').trim();
  const data = payload && typeof payload === 'object' ? payload : {};

  if (method === 'getMe') {
    const groupIdRaw = String(PROP.getProperty('VK_GROUP_ID') || '').trim().replace(/^-/, '');
    const me = vkApiCall('groups.getById', groupIdRaw ? { group_id: groupIdRaw } : {});
    if (!me.ok) return vkErrorAsTelegram(me, 'VK getMe failed');
    const first = Array.isArray(me.result) ? (me.result[0] || {}) : (me.result || {});
    return {
      ok: true,
      result: {
        id: first.id || '',
        username: first.screen_name || '',
        first_name: first.name || 'VK Bot'
      },
      vk: me.vk
    };
  }

  if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') {
    const peerId = normalizeVkPeerId(data.chat_id);
    if (!peerId) return { ok: false, description: 'VK peer_id не задан' };

    const params = {
      peer_id: peerId,
      random_id: Math.floor(Math.random() * 2147483647),
      message: String(data.text || data.caption || '').trim()
    };

    if (String(data.parse_mode || '').toUpperCase() === 'HTML') params.format = 'html';
    if (data.disable_web_page_preview) params.dont_parse_links = 1;

    const keyboard = convertTelegramReplyMarkupToVkKeyboard(data.reply_markup);
    if (keyboard) params.keyboard = keyboard;

    if (method === 'sendPhoto' && data.photo) params.attachment = String(data.photo || '').trim();
    if (method === 'sendDocument' && data.document) params.attachment = String(data.document || '').trim();

    const sent = vkApiCall('messages.send', params);
    if (!sent.ok) return vkErrorAsTelegram(sent, 'VK sendMessage failed');
    return { ok: true, result: normalizeVkSendResult(sent.result, peerId), vk: sent.vk };
  }

  if (method === 'editMessageReplyMarkup') {
    const peerId = normalizeVkPeerId(data.chat_id);
    const messageId = String(data.message_id || '').trim();
    if (!peerId || !messageId) return { ok: false, description: 'VK editMessage requires peer_id + message_id' };

    const keyboard = convertTelegramReplyMarkupToVkKeyboard(data.reply_markup || { inline_keyboard: [] });
    const byConversationId = vkApiCall('messages.edit', {
      peer_id: peerId,
      conversation_message_id: messageId,
      keyboard: keyboard || JSON.stringify({ inline: true, buttons: [] })
    });

    if (byConversationId.ok) return { ok: true, result: true, vk: byConversationId.vk };

    const byMessageId = vkApiCall('messages.edit', {
      peer_id: peerId,
      message_id: messageId,
      keyboard: keyboard || JSON.stringify({ inline: true, buttons: [] })
    });
    if (byMessageId.ok) return { ok: true, result: true, vk: byMessageId.vk };

    return vkErrorAsTelegram(byMessageId, 'VK editMessage failed');
  }

  if (method === 'deleteMessage') {
    const peerId = normalizeVkPeerId(data.chat_id);
    const messageId = String(data.message_id || '').trim();
    if (!messageId) return { ok: false, description: 'VK deleteMessage requires message_id' };

    if (peerId) {
      const delCmids = vkApiCall('messages.delete', {
        peer_id: peerId,
        cmids: messageId,
        delete_for_all: 1
      });
      if (delCmids.ok) return { ok: true, result: true, vk: delCmids.vk };
    }

    const delById = vkApiCall('messages.delete', {
      message_ids: messageId,
      delete_for_all: 1
    });
    if (delById.ok) return { ok: true, result: true, vk: delById.vk };
    return vkErrorAsTelegram(delById, 'VK deleteMessage failed');
  }

  if (method === 'answerCallbackQuery') {
    const meta = parseVkCallbackQueryId(data.callback_query_id);
    if (!meta) return { ok: true, result: true, skipped: true };

    const text = String(data.text || '').trim().slice(0, 90);
    const answer = vkApiCall('messages.sendMessageEventAnswer', {
      event_id: meta.eventId,
      user_id: meta.userId,
      peer_id: meta.peerId,
      event_data: JSON.stringify({
        type: 'show_snackbar',
        text: text || 'Обработано'
      })
    });
    if (!answer.ok) return vkErrorAsTelegram(answer, 'VK answerCallback failed');
    return { ok: true, result: true, vk: answer.vk };
  }

  if (method === 'getWebhookInfo') {
    return {
      ok: true,
      result: {
        url: resolveWebhookExecUrl(''),
        pending_update_count: 0,
        allowed_updates: ['message', 'callback_query']
      }
    };
  }

  if (method === 'setWebhook') {
    const incomingUrl = normalizeWebhookUrlToExec(data.url || '');
    if (incomingUrl && isUsableWebhookTarget(incomingUrl)) {
      PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, incomingUrl);
    }
    return { ok: true, result: true, note: 'VK callback webhook binds in VK admin panel' };
  }

  if (method === 'deleteWebhook') {
    return { ok: true, result: true, note: 'VK callback webhook binds in VK admin panel' };
  }

  if (method === 'setMyCommands') {
    return { ok: true, result: true, note: 'VK does not support Telegram-style setMyCommands' };
  }

  return { ok: false, description: 'VK adapter: unsupported method ' + method };
}

function urlFetchJson(url, options) {
  if (isVkProvider() && isTelegramApiUrl(url)) {
    const tgMethod = extractTelegramMethodName(url);
    const payload = parseRequestPayload(options && options.payload ? options.payload : null);
    return routeTelegramMethodToVk(tgMethod, payload);
  }

  const params = {
    method: options && options.method ? options.method : 'get',
    contentType: 'application/json',
    payload: options && options.payload ? options.payload : null,
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch(url, params);
  const text = resp.getContentText();
  try {
    return JSON.parse(text);
  } catch (err) {
    return { ok: false, raw: text };
  }
}

function answerCallback(token, callbackId, text) {
  if (!callbackId) return;
  urlFetchJson(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'post',
    payload: JSON.stringify({
      callback_query_id: callbackId,
      text: String(text || '').slice(0, 200),
      show_alert: false
    })
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj || {}))
    .setMimeType(ContentService.MimeType.JSON);
}
