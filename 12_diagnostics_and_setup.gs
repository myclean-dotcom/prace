/* ---------- Diagnostics & setup ---------- */

function __checkConfiguration() {
  const out = {
    buildVersion: BUILD_VERSION,
    messengerProvider: getMessengerProvider(),
    telegramRuntimeMode: getTelegramRuntimeMode(),
    spreadsheetId: String(PROP.getProperty('SPREADSHEET_ID') || '').trim() || 'NOT_SET',
    botTokenSet: !!getBotApiToken(),
    telegramChatId: String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim() || 'NOT_SET',
    telegramChatNovosibirsk: String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim() || 'NOT_SET',
    vkChatId: String(PROP.getProperty('VK_CHAT_ID') || '').trim() || 'NOT_SET',
    vkChatNovosibirsk: String(PROP.getProperty('VK_CHAT_NOVOSIBIRSK') || '').trim() || 'NOT_SET',
    telegramManagerChatId: getManagerChatId() || 'NOT_SET',
    telegramEventsChatId: getEventsChatId() || 'NOT_SET',
    storedWebAppExecUrl: String(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY) || '').trim() || 'NOT_SET',
    serviceExecUrl: getCurrentServiceExecUrl(),
    resolvedWebhookExecUrl: resolveWebhookExecUrl('')
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setTelegramRuntimeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized !== 'direct' && normalized !== 'apps_script') {
    throw new Error('Передайте mode: direct или apps_script');
  }
  PROP.setProperty(TELEGRAM_RUNTIME_MODE_PROPERTY, normalized);
  const out = {
    ok: true,
    telegramRuntimeMode: normalized,
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setMessengerProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized !== 'telegram' && normalized !== 'vk') {
    throw new Error('Передайте provider: telegram или vk');
  }
  PROP.setProperty(MESSENGER_PROVIDER_PROPERTY, normalized);
  const out = {
    ok: true,
    messengerProvider: normalized,
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __switchToDirectTelegramMode() {
  const token = getBotApiToken();
  PROP.setProperty(TELEGRAM_RUNTIME_MODE_PROPERTY, 'direct');
  let deleteWebhook = { ok: false, skipped: true, reason: 'token not set' };
  if (token) {
    deleteWebhook = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
      method: 'post',
      payload: JSON.stringify({ drop_pending_updates: true })
    });
  }
  const out = {
    ok: true,
    telegramRuntimeMode: 'direct',
    deleteWebhook: deleteWebhook,
    note: 'Apps Script больше не обрабатывает Telegram callbacks/commands',
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __switchToAppsScriptTelegramMode() {
  PROP.setProperty(TELEGRAM_RUNTIME_MODE_PROPERTY, 'apps_script');
  const out = {
    ok: true,
    telegramRuntimeMode: 'apps_script',
    note: 'Для активации webhook запустите __setWebhookProd()',
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __enableTelegramBotWithSheets(webAppExecUrl) {
  const mode = __switchToAppsScriptTelegramMode();
  let setUrl = null;
  const incomingUrl = String(webAppExecUrl || '').trim();
  if (incomingUrl) {
    setUrl = __setWebAppExecUrl(incomingUrl);
  }
  const webhook = __setWebhookProd();
  const commands = __setTelegramBotCommands();
  const scenarios = __checkButtonScenariosAndSheet();
  const out = {
    ok: true,
    buildVersion: BUILD_VERSION,
    mode: mode,
    setUrl: setUrl,
    webhook: webhook,
    commands: commands,
    scenarios: scenarios
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __checkSheetHeaders() {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const missing = REQUIRED_HEADERS.filter(function(h) { return !map[h]; });
  const out = { ok: missing.length === 0, missing: missing, sheetName: sheet.getName(), buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __checkButtonScenariosAndSheet() {
  const cfg = __checkConfiguration();
  const headers = __checkSheetHeaders();
  const mode = getTelegramRuntimeMode();

  const scenarios = [
    {
      step: 'Группа: ВЫХОЖУ НА ЗАЯВКУ',
      expectedStatus: 'Взята',
      expectedColumns: ['Master ID', 'Master Name', 'Дата принятия']
    },
    {
      step: 'Мастер: ПРИЕХАЛ НА ОБЪЕКТ',
      expectedStatus: 'На объекте',
      expectedColumns: ['Дата прибытия']
    },
    {
      step: 'Мастер: ЗАВЕРШИЛ ЗАЯВКУ',
      expectedStatus: 'Ожидает оплаты',
      expectedColumns: ['Дата завершения']
    },
    {
      step: 'Мастер: ОПЛАТА ПОЛУЧЕНА',
      expectedStatus: 'Завершена',
      expectedColumns: ['Дата оплаты']
    },
    {
      step: 'Мастер: ОТМЕНИТЬ ЗАЯВКУ',
      expectedStatus: 'Опубликована',
      expectedColumns: ['Master ID', 'Master Name', 'Дата принятия']
    }
  ];

  const out = {
    ok: headers.ok,
    buildVersion: BUILD_VERSION,
    telegramRuntimeMode: mode,
    configuration: cfg,
    headers: headers,
    scenarios: scenarios,
    note: mode === 'direct'
      ? 'Apps Script Telegram callbacks отключены (direct mode).'
      : 'Сценарии активны в Apps Script режиме.'
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setSpreadsheetId(spreadsheetId) {
  const id = String(spreadsheetId || '').trim();
  if (!id) throw new Error('Передайте spreadsheetId');
  PROP.setProperty('SPREADSHEET_ID', id);
  const sheet = getSheet();
  const out = { ok: true, spreadsheetId: id, sheetName: sheet.getName(), buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setManagerChatId(chatId) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('Передайте chatId');
  PROP.setProperty('TELEGRAM_MANAGER_CHAT_ID', id);
  const out = { ok: true, telegramManagerChatId: id, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setEventsChatId(chatId) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('Передайте chatId');
  PROP.setProperty('TELEGRAM_EVENTS_CHAT_ID', id);
  const out = { ok: true, telegramEventsChatId: id, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setWebAppExecUrl(url) {
  let normalized = normalizeWebhookUrlToExec(url);
  if (normalized && !isUsableWebhookTarget(normalized)) normalized = '';
  if (!normalized) normalized = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (normalized && !isUsableWebhookTarget(normalized)) normalized = '';
  if (!normalized) normalized = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  if (normalized && !isUsableWebhookTarget(normalized)) normalized = '';

  if (!normalized) {
    const token = getBotApiToken();
    if (token) {
      const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
      if (info && info.ok === true && info.result && info.result.url) {
        const webhookUrl = normalizeWebhookUrlToExec(info.result.url);
        if (isUsableWebhookTarget(webhookUrl)) normalized = webhookUrl;
      }
    }
  }

  if (!normalized) throw new Error('Не удалось автоматически определить URL Web App (/exec). Передайте URL вручную.');
  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, normalized);
  const out = {
    ok: true,
    storedWebAppExecUrl: normalized,
    resolvedWebhookExecUrl: resolveWebhookExecUrl(''),
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setWebhookProd() {
  const token = getBotApiToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  if (isDirectTelegramRuntime()) {
    const delDirect = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
      method: 'post',
      payload: JSON.stringify({ drop_pending_updates: true })
    });
    const outDirect = {
      ok: true,
      skipped: true,
      reason: 'direct_telegram_runtime_enabled',
      deleteWebhook: delDirect,
      note: 'Webhook для Apps Script отключен, обработка в direct_telegram_bot.js',
      buildVersion: BUILD_VERSION
    };
    Logger.log(JSON.stringify(outDirect));
    return outDirect;
  }

  const baseExecUrl = resolveWebhookExecUrl('');
  if (!baseExecUrl) throw new Error('Не удалось определить URL Web App');
  const targetInfo = resolveTelegramWebhookTarget(baseExecUrl);
  const targetUrl = targetInfo && targetInfo.targetUrl ? targetInfo.targetUrl : baseExecUrl;
  if (!isUsableWebhookTarget(targetUrl)) {
    throw new Error('Некорректный URL webhook target. Убедитесь, что используется публичный /exec URL.');
  }
  if (targetInfo && targetInfo.authBlocked) {
    throw new Error('Web App требует авторизацию Google (ServiceLogin/401). Переразверните Web App: Выполнять от моего имени, Доступ: Все.');
  }

  const del = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'post',
    payload: JSON.stringify({ drop_pending_updates: true })
  });

  const set = urlFetchJson(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'post',
    payload: JSON.stringify({
      url: targetUrl,
      allowed_updates: ['message', 'edited_message', 'callback_query']
    })
  });

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, baseExecUrl);
  PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(Date.now()));

  const out = {
    ok: !!(set && set.ok === true),
    buildVersion: BUILD_VERSION,
    baseExecUrl: baseExecUrl,
    targetUrl: targetUrl,
    redirectProbe: targetInfo ? targetInfo.redirectProbe : null,
    redirectProbeGet: targetInfo ? targetInfo.redirectProbeGet : null,
    authBlocked: !!(targetInfo && targetInfo.authBlocked),
    deleteWebhook: del,
    setWebhook: set,
    webhookInfo: info
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setTelegramBotCommands() {
  const token = getBotApiToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  if (isDirectTelegramRuntime()) {
    const outSkip = {
      ok: true,
      skipped: true,
      reason: 'direct_telegram_runtime_enabled',
      note: 'Команды выставляет direct_telegram_bot.js',
      buildVersion: BUILD_VERSION
    };
    Logger.log(JSON.stringify(outSkip));
    return outSkip;
  }

  const privateCommands = [
    { command: 'myid', description: 'Показать user_id и chat_id' },
    { command: 'setmanager', description: 'Назначить этот чат менеджерским' },
    { command: 'setevents', description: 'Назначить этот чат чатом событий' },
    { command: 'setgroup', description: 'Назначить этот чат группой заявок' },
    { command: 'setnsk', description: 'Назначить этот чат Новосибирском' },
    { command: 'testgroup', description: 'Отправить тест кнопки в группу' },
    { command: 'myorder', description: 'Моя текущая заявка' },
    { command: 'arrived', description: 'Я приехал на объект' },
    { command: 'done', description: 'Работы завершены' },
    { command: 'paid', description: 'Оплата от клиента получена' },
    { command: 'cancel', description: 'Отменить текущую заявку' },
    { command: 'menu', description: 'Сценарии кнопок и команды' },
    { command: 'panel', description: 'Показать панель кнопок' },
    { command: 'hidepanel', description: 'Скрыть панель кнопок' },
    { command: 'active', description: 'Заявки в работе (менеджер)' },
    { command: 'planned', description: 'Запланированные заявки (менеджер)' },
    { command: 'pay', description: 'Выбрать заявку и отправить оплату' },
    { command: 'help', description: 'Справка по командам' }
  ];

  const groupCommands = [
    { command: 'myid', description: 'Показать user_id и chat_id' },
    { command: 'setmanager', description: 'Назначить этот чат менеджерским' },
    { command: 'setevents', description: 'Назначить этот чат чатом событий' },
    { command: 'setgroup', description: 'Назначить этот чат группой заявок' },
    { command: 'setnsk', description: 'Назначить этот чат Новосибирском' },
    { command: 'testgroup', description: 'Отправить тест кнопки в группу' },
    { command: 'menu', description: 'Сценарии кнопок и команды' },
    { command: 'panel', description: 'Показать панель кнопок' },
    { command: 'hidepanel', description: 'Скрыть панель кнопок' },
    { command: 'active', description: 'Заявки в работе сейчас' },
    { command: 'planned', description: 'Запланированные заявки' },
    { command: 'pay', description: 'Выбрать заявку и отправить оплату' },
    { command: 'help', description: 'Справка по командам' }
  ];

  const defaultResp = urlFetchJson(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'post',
    payload: JSON.stringify({
      commands: privateCommands,
      scope: { type: 'default' }
    })
  });

  const privateResp = urlFetchJson(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'post',
    payload: JSON.stringify({
      commands: privateCommands,
      scope: { type: 'all_private_chats' }
    })
  });

  const groupResp = urlFetchJson(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'post',
    payload: JSON.stringify({
      commands: groupCommands,
      scope: { type: 'all_group_chats' }
    })
  });

  const out = {
    ok: true,
    buildVersion: BUILD_VERSION,
    defaultSet: defaultResp,
    privateSet: privateResp,
    groupSet: groupResp
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __hardResetBotRouting() {
  if (isDirectTelegramRuntime()) {
    return __switchToDirectTelegramMode();
  }
  return __setWebhookProd();
}

function __setProdUrlAndCheckButton(url) {
  const target = normalizeWebhookUrlToExec(url) || normalizeWebhookUrlToExec(DEFAULT_PROD_EXEC_URL);
  if (!target) throw new Error('Не удалось определить целевой /exec URL');

  let setUrl = __setWebAppExecUrl(target);
  let setWebhook = __setWebhookProd();
  let check = __checkAllButtonReasons(target);

  let autoSwitched = false;
  let switchedToUrl = '';
  let fallbackInfo = null;

  const checkFailures = (check && check.failures) ? check.failures : [];
  const hasBuildMismatch = checkFailures.some(function(msg) {
    return String(msg || '').toLowerCase().indexOf('другой buildversion') !== -1;
  });
  const hasProbeUnknownAction = checkFailures.some(function(msg) {
    return String(msg || '').toLowerCase().indexOf('unknown action') !== -1;
  });

  if (hasBuildMismatch || hasProbeUnknownAction) {
    const serviceUrl = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
    if (serviceUrl && serviceUrl !== target) {
      autoSwitched = true;
      switchedToUrl = serviceUrl;

      setUrl = __setWebAppExecUrl(serviceUrl);
      setWebhook = __setWebhookProd();
      check = __checkAllButtonReasons(serviceUrl);

      fallbackInfo = {
        reason: 'target_url_has_old_build_or_unknown_action',
        targetUrl: target,
        switchedToUrl: serviceUrl
      };
    }
  }

  const out = {
    ok: !!(check && check.ok),
    buildVersion: BUILD_VERSION,
    targetUrl: target,
    autoSwitched: autoSwitched,
    switchedToUrl: switchedToUrl,
    fallbackInfo: fallbackInfo,
    setUrl: setUrl,
    setWebhook: setWebhook,
    check: check
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __getTelegramWebhookInfo() {
  const token = getBotApiToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
  const out = { ok: true, buildVersion: BUILD_VERSION, webhookInfo: info };
  Logger.log(JSON.stringify(out));
  return out;
}

// Backward-compatible alias used in docs and previous builds.
function __checkButtonEndToEnd(targetUrl) {
  return __checkAllButtonReasons(targetUrl || '');
}

function __checkAllButtonReasons(targetUrl) {
  const out = {
    ok: true,
    buildVersion: BUILD_VERSION,
    checkedAt: formatDateTime(new Date()),
    checks: {},
    failures: [],
    warnings: [],
    advice: []
  };

  const pushFailure = function(message, advice) {
    out.ok = false;
    out.failures.push(message);
    if (advice) out.advice.push(advice);
  };
  const pushWarning = function(message, advice) {
    out.warnings.push(message);
    if (advice) out.advice.push(advice);
  };

  const provider = getMessengerProvider();
  const token = getBotApiToken();
  const spreadsheetId = String(PROP.getProperty('SPREADSHEET_ID') || '').trim();
  const chatNovosibirsk = provider === 'vk'
    ? String(PROP.getProperty('VK_CHAT_NOVOSIBIRSK') || PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim()
    : String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim();
  const chatFallback = provider === 'vk'
    ? String(PROP.getProperty('VK_CHAT_ID') || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim()
    : String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  const managerChatId = String(PROP.getProperty('TELEGRAM_MANAGER_CHAT_ID') || '').trim();
  const eventsChatId = String(PROP.getProperty('TELEGRAM_EVENTS_CHAT_ID') || '').trim();

  const serviceExecUrl = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  const storedExecUrl = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  const resolvedExecUrl = normalizeWebhookUrlToExec(resolveWebhookExecUrl(targetUrl || ''));

  out.checks.properties = {
    messengerProvider: provider,
    runtimeMode: getTelegramRuntimeMode(),
    tokenSet: !!token,
    spreadsheetIdSet: !!spreadsheetId,
    telegramChatNovosibirskSet: !!chatNovosibirsk,
    telegramChatFallbackSet: !!chatFallback,
    managerChatIdSet: !!managerChatId,
    eventsChatIdSet: !!eventsChatId
  };
  out.checks.urls = {
    serviceExecUrl: serviceExecUrl || '',
    storedExecUrl: storedExecUrl || '',
    resolvedExecUrl: resolvedExecUrl || ''
  };

  if (isDirectTelegramRuntime()) {
    out.ok = true;
    out.warnings.push('Apps Script Telegram routing отключен (direct mode).');
    out.advice.push('Кнопки/команды обрабатывает внешний direct_telegram_bot.js.');
    Logger.log(JSON.stringify(out));
    return out;
  }

  if (!token) {
    pushFailure(
      provider === 'vk' ? 'VK_BOT_TOKEN не задан.' : 'TELEGRAM_BOT_TOKEN не задан.',
      provider === 'vk' ? 'Добавьте VK_BOT_TOKEN (или TELEGRAM_BOT_TOKEN для совместимости) в Script Properties.' : 'Добавьте TELEGRAM_BOT_TOKEN в Script Properties.'
    );
  }
  if (!spreadsheetId) {
    pushFailure('SPREADSHEET_ID не задан.', 'Добавьте SPREADSHEET_ID в Script Properties.');
  }
  if (!chatNovosibirsk && !chatFallback) {
    pushFailure(
      'Не задан chat id для публикации заявок.',
      provider === 'vk'
        ? 'Добавьте VK_CHAT_NOVOSIBIRSK или VK_CHAT_ID.'
        : 'Добавьте TELEGRAM_CHAT_NOVOSIBIRSK или TELEGRAM_CHAT_ID.'
    );
  }
  if (!eventsChatId) {
    pushWarning('TELEGRAM_EVENTS_CHAT_ID не задан.', 'Задайте TELEGRAM_EVENTS_CHAT_ID для отдельной группы уведомлений менеджера.');
  }
  if (!resolvedExecUrl) {
    pushFailure('Не удалось определить Web App URL (/exec).', 'Запустите __setWebAppExecUrl("ВАШ_/exec_URL"), затем __setWebhookProd().');
  }
  if (storedExecUrl && serviceExecUrl && storedExecUrl !== serviceExecUrl) {
    pushWarning('stored WEBAPP_EXEC_URL не совпадает с ScriptApp.getService().getUrl().', 'Если кнопка не работает, запустите __setWebhookProd() после правильного деплоя.');
  }

  if (token) {
    const me = urlFetchJson(`https://api.telegram.org/bot${token}/getMe`, { method: 'get' });
    out.checks.telegramGetMe = me;
    if (!me || me.ok !== true || !me.result) {
      pushFailure(
        (provider === 'vk' ? 'VK' : 'Telegram') + ' getMe вернул ошибку (токен/бот недоступен).',
        provider === 'vk'
          ? 'Проверьте VK_BOT_TOKEN и запустите __checkAllButtonReasons снова.'
          : 'Проверьте TELEGRAM_BOT_TOKEN и запустите __checkAllButtonReasons снова.'
      );
    }

    const webhookInfo = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
    out.checks.webhookInfo = webhookInfo;
    if (!webhookInfo || webhookInfo.ok !== true || !webhookInfo.result) {
      pushFailure('Не удалось получить getWebhookInfo.', 'Проверьте токен и доступность Telegram API.');
    } else {
      const currentWebhookUrl = normalizeWebhookUrlToExec(webhookInfo.result.url);
      const targetInfo = resolveTelegramWebhookTarget(resolvedExecUrl || '');
      const expectedWebhookTargetUrl = targetInfo.targetUrl || (resolvedExecUrl || '');
      const pending = Number(webhookInfo.result.pending_update_count || 0);
      const allowed = webhookInfo.result.allowed_updates || [];
      const hasCallback = Array.isArray(allowed)
        ? allowed.indexOf('callback_query') !== -1
        : String(allowed || '').indexOf('callback_query') !== -1;
      const lastError = String(webhookInfo.result.last_error_message || '').trim();
      const lastErrorDate = Number(webhookInfo.result.last_error_date || 0);

      out.checks.webhookNormalized = {
        currentWebhookUrl: currentWebhookUrl || '',
        expectedWebhookUrl: resolvedExecUrl || '',
        expectedWebhookTargetUrl: expectedWebhookTargetUrl || '',
        authBlocked: !!(targetInfo && targetInfo.authBlocked),
        pendingUpdateCount: pending,
        allowedUpdates: allowed,
        hasCallbackQuery: hasCallback,
        lastErrorMessage: lastError || '',
        lastErrorDate: lastErrorDate || 0
      };

      if (!currentWebhookUrl) {
        pushFailure('Webhook в Telegram не установлен.', 'Запустите __setWebhookProd().');
      } else if (isGoogleLoginUrl(currentWebhookUrl)) {
        pushFailure('Webhook указывает на страницу логина Google (accounts.google.com).', 'Web App закрыт авторизацией. Разверните Web App с доступом "Все", затем запустите __setWebhookProd().');
      } else if (expectedWebhookTargetUrl && !webhookUrlsEquivalent(currentWebhookUrl, expectedWebhookTargetUrl)) {
        pushFailure('Webhook указывает не на ожидаемый URL (после редиректа).', 'Запустите __setWebhookProd() в текущем проекте.');
      }

      if (targetInfo && targetInfo.authBlocked) {
        pushFailure('Web App закрыт авторизацией Google (ServiceLogin/401).', 'Переразверните Web App: Выполнять от моего имени, Доступ: Все.');
      }

      if (!hasCallback) {
        pushFailure('В webhook не включен callback_query.', 'Запустите __setWebhookProd(), он задаст allowed_updates корректно.');
      }

      if (pending > 0) {
        pushWarning('У webhook есть pending updates: ' + pending + '.', 'Обычно это временно. Если долго не уходит, запустите __setWebhookProd().');
      }

      if (lastError) {
        pushWarning('Telegram сообщает last_error_message: ' + lastError, 'После исправлений нажмите кнопку и снова запустите __checkAllButtonReasons().');
      }
      if (lastError.indexOf('302') !== -1) {
        pushFailure('Telegram получает 302 от webhook (нужно ставить финальный URL без редиректа).', 'Запустите __setWebhookProd() в текущей версии проекта.');
      }
    }
  }

  if (resolvedExecUrl) {
    const health = checkWebAppPublicHealth(resolvedExecUrl);
    out.checks.webAppHealth = health;
    if (!health.ok || health.statusCode !== 200 || health.bodyJsonOk !== true) {
      pushFailure(
        'Web App health-check неуспешен (внешний GET /?health=1).',
        'Переразверните Web App: "Выполнять от моего имени", "Доступ: Все".'
      );
    }

    const probe = __probeWebhookDoPostVersion(resolvedExecUrl);
    out.checks.doPostProbe = probe;
    if (!probe || probe.ok !== true) {
      pushFailure(
        'Внешний POST до doPost неуспешен.',
        'Проверьте публичность Web App и что используется URL именно с /exec.'
      );
    } else {
      const body = probe.bodyJson || {};
      const action = String(body.action || '').trim();
      const probeBuild = String(body.buildVersion || '').trim();
      const probeError = String(body.error || '').trim();

      if (action !== 'probe_version' || body.ok !== true) {
        pushFailure(
          'doPost ответил не на probe_version (возможен старый код/другой деплой).',
          'Проверьте, что frontend и webhook смотрят на один и тот же /exec URL.'
        );
      }
      if (probeBuild && probeBuild !== BUILD_VERSION) {
        pushFailure(
          'doPost вернул другой buildVersion: ' + probeBuild,
          'Вызывается не текущая версия скрипта. Переразверните Web App и заново запустите __setWebhookProd().'
        );
      }
      if (probeError && probeError.toLowerCase().indexOf('unknown action') !== -1) {
        pushFailure(
          'doPost вернул unknown action на probe_version.',
          'Это почти всегда признак старого/чужого backend URL.'
        );
      }
    }
  }

  const parserSamples = [
    'take:CLN-12345678',
    'take_CLN-12345678',
    'take|CLN-12345678',
    '{"action":"take","orderId":"CLN-12345678"}',
    'paid:CLN-12345678'
  ];
  const parserChecks = [];
  for (let i = 0; i < parserSamples.length; i++) {
    const sample = parserSamples[i];
    const parsed = parseCallbackActionData(sample);
    parserChecks.push({ sample: sample, parsed: parsed });
    const expectedAction = sample.indexOf('paid:') === 0 ? CALLBACK_ACTIONS.PAID : CALLBACK_ACTIONS.TAKE;
    if (!parsed || parsed.action !== expectedAction || parsed.orderId !== 'CLN-12345678') {
      pushFailure('parseCallbackActionData не проходит self-test для: ' + sample, 'Проверьте parseCallbackActionData в текущей версии кода.');
    }
  }
  out.checks.callbackParser = parserChecks;

  if (!out.failures.length) {
    out.advice.push('Критических проблем не найдено. Если кнопка не реагирует, нажмите кнопку и сразу запустите __getTelegramWebhookInfo() и __checkAllButtonReasons() повторно.');
  }

  Logger.log(JSON.stringify(out));
  return out;
}

function checkWebAppPublicHealth(execUrl) {
  const url = normalizeWebhookUrlToExec(execUrl);
  if (!url) {
    return { ok: false, statusCode: 0, bodyJsonOk: false, error: 'empty url', url: '' };
  }

  const healthUrl = url + (url.indexOf('?') === -1 ? '?health=1' : '&health=1');
  try {
    const resp = UrlFetchApp.fetch(healthUrl, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true
    });
    const statusCode = resp.getResponseCode();
    const text = String(resp.getContentText() || '');
    let bodyJson = null;
    try { bodyJson = JSON.parse(text); } catch (err) {}

    return {
      ok: statusCode >= 200 && statusCode < 300,
      url: healthUrl,
      statusCode: statusCode,
      bodyJsonOk: !!(bodyJson && bodyJson.ok === true),
      bodyJson: bodyJson,
      bodySnippet: text.slice(0, 300)
    };
  } catch (err) {
    return {
      ok: false,
      url: healthUrl,
      statusCode: 0,
      bodyJsonOk: false,
      error: err.message
    };
  }
}

function __deleteTelegramWebhook() {
  const token = getBotApiToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'post',
    payload: JSON.stringify({ drop_pending_updates: true })
  });
  Logger.log(JSON.stringify(resp));
  return resp;
}

function __probeWebhookDoPostVersion(targetUrl) {
  const url = resolveWebhookExecUrl(targetUrl || '');
  if (!url) return { ok: false, error: 'webhook url not available', buildVersion: BUILD_VERSION };

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      payload: 'action=probe_version',
      muteHttpExceptions: true,
      followRedirects: true
    });

    const code = resp.getResponseCode();
    const bodyText = resp.getContentText() || '';
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch (err) {}

    const out = {
      ok: code >= 200 && code < 300,
      statusCode: code,
      url: url,
      bodyJson: bodyJson,
      bodySnippet: bodyText.slice(0, 300),
      buildVersion: BUILD_VERSION
    };
    Logger.log(JSON.stringify(out));
    return out;
  } catch (err) {
    const out = { ok: false, error: err.message, url: url, buildVersion: BUILD_VERSION };
    Logger.log(JSON.stringify(out));
    return out;
  }
}

function __testTelegramSend() {
  const token = getBotApiToken();
  const chat = getMessengerProvider() === 'vk'
    ? String(PROP.getProperty('VK_CHAT_NOVOSIBIRSK') || PROP.getProperty('VK_CHAT_ID') || PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim()
    : String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  if (!chat) throw new Error('TELEGRAM_CHAT_NOVOSIBIRSK/TELEGRAM_CHAT_ID не задан');

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({ chat_id: chat, text: '✅ Тест Telegram из Apps Script' })
  });

  Logger.log(JSON.stringify(resp));
  return resp;
}

function __sendTestGroupMessage() {
  const token = getBotApiToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');

  const managerChat = getMessengerProvider() === 'vk'
    ? String(getManagerChatId() || PROP.getProperty('VK_CHAT_ID') || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim()
    : String(getManagerChatId() || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  const out = sendGroupCallbackTestMessage(token, managerChat, managerChat);
  Logger.log(JSON.stringify(out));
  return out;
}

function __testCreateOrder() {
  const payload = {
    action: 'create',
    orderId: 'TEST-' + Date.now().toString().slice(-8),
    manager: 'Тест',
    customerName: 'Тест',
    customerPhone: '+79990000000',
    customerCity: 'Новосибирск',
    customerAddress: 'Тестовая улица, 1',
    customerFlat: '1',
    orderDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy'),
    orderTime: '12:00',
    orderTotal: '1000',
    masterPay: '600',
    cleaningType: 'Тест',
    area: '10',
    chemistry: '—',
    equipment: '—',
    worksDescription: 'Тестовая заявка'
  };

  const resp = createOrUpdateOrder(payload, 'create');
  Logger.log(resp.getContent());
  return resp;
}

function __setupReminderTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendReminders') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  const trigger = ScriptApp.newTrigger('sendReminders')
    .timeBased()
    .everyMinutes(5)
    .create();

  const out = {
    ok: true,
    triggerId: trigger && trigger.getUniqueId ? trigger.getUniqueId() : '',
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __removeReminderTrigger() {
  let removed = 0;
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendReminders') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  const out = { ok: true, removed: removed, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __normalizeCreatedAtColumn() {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const col = map['Дата создания'];
  const lastRow = sheet.getLastRow();

  if (!col || lastRow < 2) {
    const out = { ok: true, updated: 0, buildVersion: BUILD_VERSION };
    Logger.log(JSON.stringify(out));
    return out;
  }

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  let updated = 0;
  for (let i = 0; i < values.length; i++) {
    const prev = values[i][0];
    const norm = normalizeCreatedAtValue(prev);
    if (String(prev || '') !== String(norm || '')) {
      sheet.getRange(i + 2, col).setValue(norm);
      updated++;
    }
  }

  const out = { ok: true, updated: updated, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}
