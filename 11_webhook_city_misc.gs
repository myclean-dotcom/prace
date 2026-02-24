/* ---------- Webhook routing ---------- */

function normalizeWebhookUrlToExec(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.indexOf('/exec') !== -1) return value;
  if (value.indexOf('/dev') !== -1) return value.replace(/\/dev(?:$|\?)/, '/exec');
  return value;
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
  if (preferred) return preferred;

  const stored = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  if (stored) return stored;

  const service = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (service) return service;

  return '';
}

function ensureWebhookBoundToCurrentExec(force) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return { ok: false, reason: 'token_not_set' };

  const targetUrl = resolveWebhookExecUrl('');
  if (!targetUrl) return { ok: false, reason: 'exec_url_not_set' };

  const now = Date.now();
  const lastSync = Number(PROP.getProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY) || '0');
  if (!force && lastSync > 0 && (now - lastSync) < 3 * 60 * 1000) {
    return { ok: true, skipped: true, targetUrl: targetUrl };
  }

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
  const currentUrl = info && info.result && info.result.url
    ? normalizeWebhookUrlToExec(info.result.url)
    : '';

  if (currentUrl !== targetUrl) {
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

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, targetUrl);
  PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(now));

  return { ok: true, targetUrl: targetUrl, currentWebhookUrl: currentUrl, changed: currentUrl !== targetUrl };
}

/* ---------- City/chat resolve ---------- */

function normalizeCityKey(city) {
  return String(city || '').trim().toLowerCase();
}

function resolveTelegramChat(city, fallbackTelegramChannel) {
  const cityKey = normalizeCityKey(city);
  const map = {
    'новосибирск': String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim()
  };

  const cityChat = String(map[cityKey] || '').trim();
  const fallback = String(fallbackTelegramChannel || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
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

function urlFetchJson(url, options) {
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

