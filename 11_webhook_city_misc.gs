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
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
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
