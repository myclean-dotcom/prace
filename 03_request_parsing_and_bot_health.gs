/* ---------- Incoming body ---------- */

function parseIncomingBody(event) {
  const param = event.parameter || {};
  const params = flattenParameters(event.parameters || {});
  const raw = event.postData && event.postData.contents ? String(event.postData.contents) : '';

  let body = {};

  if (raw) {
    const parsedRaw = tryParseJson(raw);
    if (parsedRaw && typeof parsedRaw === 'object') {
      body = parsedRaw;
    } else {
      body = parseFormEncoded(raw);
    }
  } else {
    body = Object.keys(param).length ? param : params;
  }

  if (!body || !Object.keys(body).length) {
    body = Object.keys(param).length ? param : params;
  }

  body = unwrapBodyPayload(body);

  const action = String(body.action || '').trim().toLowerCase();
  if (action) body.action = action;
  if (!action && looksLikeCreateOrderPayload(body)) body.action = 'create';

  return (body && typeof body === 'object') ? body : {};
}

function flattenParameters(parameters) {
  const out = {};
  const keys = Object.keys(parameters || {});
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = parameters[key];
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function parseFormEncoded(raw) {
  const text = String(raw || '');
  if (!text || text.indexOf('=') === -1) return {};

  const out = {};
  const pairs = text.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (!p) continue;

    const eq = p.indexOf('=');
    const key = eq >= 0 ? p.slice(0, eq) : p;
    const val = eq >= 0 ? p.slice(eq + 1) : '';
    const decodedKey = decodeURIComponent(String(key || '').replace(/\+/g, ' '));
    const decodedVal = decodeURIComponent(String(val || '').replace(/\+/g, ' '));
    if (!decodedKey) continue;
    out[decodedKey] = decodedVal;
  }

  return out;
}

function unwrapBodyPayload(body) {
  let current = body || {};

  for (let i = 0; i < 6; i++) {
    if (typeof current === 'string') {
      const parsed = tryParseJson(current);
      if (parsed && typeof parsed === 'object') {
        current = parsed;
        continue;
      }
      break;
    }

    if (!current || typeof current !== 'object') break;

    const parsedJson = tryParseJson(current.json);
    if (parsedJson && typeof parsedJson === 'object') {
      current = parsedJson;
      continue;
    }

    const parsedPayload = tryParseJson(current.payload);
    if (parsedPayload && typeof parsedPayload === 'object') {
      current = parsedPayload;
      continue;
    }

    const parsedData = tryParseJson(current.data);
    if (parsedData && typeof parsedData === 'object') {
      current = parsedData;
      continue;
    }

    break;
  }

  return (current && typeof current === 'object') ? current : {};
}

function looksLikeCreateOrderPayload(body) {
  if (!body || typeof body !== 'object') return false;

  const keys = Object.keys(body);
  if (!keys.length) return false;

  const hints = [
    'manager',
    'customerName',
    'customerPhone',
    'customerAddress',
    'customerCity',
    'cleaningType',
    'orderTotal',
    'masterPay'
  ];

  for (let i = 0; i < hints.length; i++) {
    if (Object.prototype.hasOwnProperty.call(body, hints[i])) return true;
  }

  return false;
}

function pickPayloadValue(payload, keys, fallback) {
  const source = payload || {};
  const list = Array.isArray(keys) ? keys : [keys];
  for (let i = 0; i < list.length; i++) {
    const key = String(list[i] || '').trim();
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        const joined = value.map(function(v) { return String(v || '').trim(); }).filter(Boolean).join(', ');
        if (joined) return joined;
        continue;
      }
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return String(fallback || '').trim();
}

/* ---------- Bot health ---------- */

function checkTelegramBotStatus() {
  const runtimeMode = getTelegramRuntimeMode();
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) {
    return jsonResponse({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN не задан',
      buildVersion: BUILD_VERSION,
      apiSignature: BACKEND_API_SIGNATURE,
      runtimeMode: runtimeMode
    });
  }

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/getMe`, { method: 'get' });
  if (!resp || resp.ok !== true || !resp.result) {
    return jsonResponse({
      ok: false,
      error: (resp && (resp.description || resp.error || resp.note)) || 'Ошибка проверки бота',
      telegram: resp || null,
      buildVersion: BUILD_VERSION,
      apiSignature: BACKEND_API_SIGNATURE,
      runtimeMode: runtimeMode
    });
  }

  return jsonResponse({
    ok: true,
    bot: { id: resp.result.id, username: resp.result.username || '', first_name: resp.result.first_name || '' },
    buildVersion: BUILD_VERSION,
    apiSignature: BACKEND_API_SIGNATURE,
    runtimeMode: runtimeMode,
    capabilities: {
      briefEquipmentInGroup: true,
      managerBotCommands: runtimeMode !== 'direct'
    }
  });
}
