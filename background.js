const TAB_SESSION_KEY_PREFIX = "tab-settings:";
const REMINDER_SETTINGS_KEY = "reminder-settings";
const NOTIFICATION_ICON = "icons/icon128.png";
const QQ_MAIL_BRIDGE_URL = "http://127.0.0.1:8787/send";
const PLAYBACK_RATES = new Set([1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]);
const REMINDER_MODES = new Set(["system", "qqmail", "both"]);

const DEFAULT_TAB_SETTINGS = Object.freeze({
  enabled: false,
  playbackRate: 1
});

const DEFAULT_REMINDER_SETTINGS = Object.freeze({
  mode: "system",
  qqMail: Object.freeze({
    recipient: "",
    bridgeToken: ""
  }),
  pauseReminder: true
});

function tabSessionKey(tabId) {
  return `${TAB_SESSION_KEY_PREFIX}${tabId}`;
}

function isSupportedUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function normalizePlaybackRate(value) {
  const playbackRate = Number(value);
  return PLAYBACK_RATES.has(playbackRate) ? playbackRate : 1;
}

function normalizeTabSettings(value) {
  return {
    enabled: value?.enabled === true,
    playbackRate: normalizePlaybackRate(value?.playbackRate)
  };
}

function normalizeQqMailSettings(value) {
  return {
    recipient: typeof value?.recipient === "string" ? value.recipient.trim() : "",
    bridgeToken: typeof value?.bridgeToken === "string" ? value.bridgeToken.trim() : ""
  };
}

function normalizeReminderSettings(value) {
  return {
    mode: REMINDER_MODES.has(value?.mode) ? value.mode : DEFAULT_REMINDER_SETTINGS.mode,
    qqMail: normalizeQqMailSettings(value?.qqMail),
    pauseReminder: value?.pauseReminder !== false
  };
}

function isQqMailConfigured(settings) {
  const { recipient, bridgeToken } = settings.qqMail;
  return Boolean(recipient && bridgeToken);
}

function withReminderMetadata(settings) {
  return {
    ...settings,
    qqMailConfigured: isQqMailConfigured(settings)
  };
}

async function getTabSettings(tabId) {
  if (!Number.isInteger(tabId)) {
    return { ...DEFAULT_TAB_SETTINGS, pauseReminder: true };
  }

  const key = tabSessionKey(tabId);
  const [savedState, reminderSettings] = await Promise.all([
    chrome.storage.session.get(key),
    getReminderSettings()
  ]);
  return {
    ...normalizeTabSettings(savedState[key]),
    pauseReminder: reminderSettings.pauseReminder
  };
}

async function saveTabSettings(tabId, settings) {
  const normalized = normalizeTabSettings(settings);
  const key = tabSessionKey(tabId);

  if (!normalized.enabled && normalized.playbackRate === 1) {
    await chrome.storage.session.remove(key);
    return normalized;
  }

  await chrome.storage.session.set({ [key]: normalized });
  return normalized;
}

async function updateTabSettings(tabId, changes) {
  const current = await getTabSettings(tabId);
  return saveTabSettings(tabId, { ...current, ...changes });
}

async function clearTabSettings(tabId) {
  await chrome.storage.session.remove(tabSessionKey(tabId));
}

async function getReminderSettings() {
  const savedSettings = await chrome.storage.local.get(REMINDER_SETTINGS_KEY);
  return withReminderMetadata(normalizeReminderSettings(savedSettings[REMINDER_SETTINGS_KEY]));
}

async function saveReminderSettings(changes) {
  const current = await getReminderSettings();
  const next = normalizeReminderSettings({
    mode: changes?.mode ?? current.mode,
    qqMail: { ...current.qqMail, ...changes?.qqMail },
    pauseReminder: changes?.pauseReminder ?? current.pauseReminder
  });
  await chrome.storage.local.set({ [REMINDER_SETTINGS_KEY]: next });
  return withReminderMetadata(next);
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"]
  });
}

async function getTabStatus(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const supported = isSupportedUrl(tab.url);
    const [tabSettings, reminderSettings] = await Promise.all([
      getTabSettings(tabId),
      getReminderSettings()
    ]);

    return {
      ...tabSettings,
      enabled: supported && tabSettings.enabled,
      supported,
      reminderSettings
    };
  } catch {
    return {
      ...DEFAULT_TAB_SETTINGS,
      supported: false,
      reminderSettings: await getReminderSettings()
    };
  }
}

async function updateCurrentTabSettings(tabId, changes) {
  const currentStatus = await getTabStatus(tabId);
  if (!currentStatus.supported) {
    await clearTabSettings(tabId);
    return {
      success: false,
      ...DEFAULT_TAB_SETTINGS,
      supported: false,
      reminderSettings: currentStatus.reminderSettings,
      error: "此页面不支持视频控制。"
    };
  }

  const settings = await updateTabSettings(tabId, changes);

  try {
    // The content script is idempotent and updates every accessible frame.
    await injectContentScript(tabId);
    return {
      success: true,
      ...settings,
      supported: true,
      reminderSettings: currentStatus.reminderSettings
    };
  } catch (error) {
    if (changes.enabled === true) {
      await updateTabSettings(tabId, { enabled: false });
    }

    return {
      success: false,
      ...(await getTabSettings(tabId)),
      supported: true,
      reminderSettings: currentStatus.reminderSettings,
      error: error instanceof Error ? error.message : "无法注入页面控制脚本。"
    };
  }
}

async function showSystemNotification(tabId) {
  const notificationId = `video-ended-${tabId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title: "视频播放完成",
    message: "当前网页中的视频已播放完成。",
    priority: 1
  });
}

async function requestQqMailDelivery({ subject, text }) {
  const settings = await getReminderSettings();
  if (!isQqMailConfigured(settings)) {
    throw new Error("请先保存 QQ 邮箱设置。");
  }

  let response;
  try {
    response = await fetch(QQ_MAIL_BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Video-Reminder-Token": settings.qqMail.bridgeToken
      },
      body: JSON.stringify({
        to: settings.qqMail.recipient,
        subject,
        text
      })
    });
  } catch {
    throw new Error("未连接到 QQ 邮箱服务。请先启动 qq-mail-bridge。");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `QQ 邮箱发送失败（${response.status}）。`);
  }
}

async function sendQqMailReminder(tabId, pageTitle) {
  const tab = await chrome.tabs.get(tabId);
  const completedAt = new Date().toLocaleString("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium"
  });
  const title = tab.title || pageTitle || "当前网页";
  const pageUrl = tab.url || "";
  await requestQqMailDelivery({
    subject: "视频播放完成",
    text: `视频播放完成。\n\n页面：${title}\n链接：${pageUrl}\n完成时间：${completedAt}`
  });
}

async function sendTestQqMail() {
  await requestQqMailDelivery({
    subject: "视频完播提醒 - 测试邮件",
    text: "QQ 邮箱提醒已经配置成功。之后网页视频播放结束时，您将收到此类提醒。"
  });
  return { success: true };
}

async function sendCompletionReminders(tabId, pageTitle) {
  const tabSettings = await getTabSettings(tabId);
  if (!tabSettings.enabled) {
    return;
  }

  const reminderSettings = await getReminderSettings();
  const actions = [];

  if (reminderSettings.mode === "system" || reminderSettings.mode === "both") {
    actions.push(showSystemNotification(tabId));
  }
  if (reminderSettings.mode === "qqmail" || reminderSettings.mode === "both") {
    actions.push(sendQqMailReminder(tabId, pageTitle));
  }

  await Promise.allSettled(actions);
}

const lastPauseAlertTime = new Map();
const PAUSE_ALERT_COOLDOWN_MS = 60_000;

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) {
    return "";
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}分${s < 10 ? "0" : ""}${s}秒`;
}

async function showPauseNotification(tabId) {
  const notificationId = `video-paused-${tabId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title: "⚠️ 视频播放异常暂停",
    message: "检测到视频已暂停超过 20 秒（疑似防挂机弹窗），请及时处理。",
    priority: 2
  });
}

async function sendQqMailPauseReminder(tabId, pageTitle, currentTime, duration) {
  const tab = await chrome.tabs.get(tabId);
  const pausedAt = new Date().toLocaleString("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium"
  });
  const title = tab.title || pageTitle || "当前网页";
  const pageUrl = tab.url || "";

  let progressInfo = "";
  if (duration > 0) {
    progressInfo = `\n播放进度：${formatDuration(currentTime)} / ${formatDuration(duration)}`;
  }

  await requestQqMailDelivery({
    subject: "⚠️【提醒】视频播放异常暂停",
    text: `检测到当前视频已暂停播放超过 20 秒，可能出现防挂机验证弹窗或播放中断，请及时处理。${progressInfo}\n\n页面：${title}\n链接：${pageUrl}\n暂停时间：${pausedAt}`
  });
}

async function sendPauseReminders(tabId, pageTitle, currentTime, duration) {
  const tabSettings = await getTabSettings(tabId);
  if (!tabSettings.enabled || tabSettings.pauseReminder === false) {
    return;
  }

  const now = Date.now();
  const lastTime = lastPauseAlertTime.get(tabId) || 0;
  if (now - lastTime < PAUSE_ALERT_COOLDOWN_MS) {
    return;
  }
  lastPauseAlertTime.set(tabId, now);

  const reminderSettings = await getReminderSettings();
  const actions = [];

  if (reminderSettings.mode === "system" || reminderSettings.mode === "both") {
    actions.push(showPauseNotification(tabId));
  }
  if (reminderSettings.mode === "qqmail" || reminderSettings.mode === "both") {
    actions.push(sendQqMailPauseReminder(tabId, pageTitle, currentTime, duration));
  }

  await Promise.allSettled(actions);
}

function respond(promise, sendResponse) {
  promise.then(sendResponse).catch((error) => {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : "操作失败，请重试。"
    });
  });
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "GET_TAB_SETTINGS") {
    return respond(getTabSettings(sender.tab?.id), sendResponse);
  }

  if (message.type === "GET_TAB_STATUS") {
    return respond(getTabStatus(message.tabId), sendResponse);
  }

  if (message.type === "SET_TRACKING") {
    return respond(
      updateCurrentTabSettings(message.tabId, { enabled: message.enabled === true }),
      sendResponse
    );
  }

  if (message.type === "SET_PLAYBACK_RATE") {
    const playbackRate = normalizePlaybackRate(message.playbackRate);
    if (Number(message.playbackRate) !== playbackRate) {
      sendResponse({ success: false, error: "不支持的播放倍速。" });
      return;
    }
    return respond(
      updateCurrentTabSettings(message.tabId, { playbackRate }),
      sendResponse
    );
  }

  if (message.type === "SAVE_REMINDER_SETTINGS") {
    return respond(
      saveReminderSettings({
        mode: message.mode,
        qqMail: message.qqMail,
        pauseReminder: message.pauseReminder
      }),
      sendResponse
    );
  }

  if (message.type === "SEND_TEST_QQ_MAIL") {
    return respond(sendTestQqMail(), sendResponse);
  }

  if (message.type === "VIDEO_ENDED" && sender.tab?.id !== undefined) {
    lastPauseAlertTime.delete(sender.tab.id);
    sendCompletionReminders(sender.tab.id, message.pageTitle).catch(() => {
      // A delivery failure must not disrupt page-side video monitoring.
    });
  }

  if (message.type === "VIDEO_PAUSED" && sender.tab?.id !== undefined) {
    sendPauseReminders(
      sender.tab.id,
      message.pageTitle,
      message.currentTime,
      message.duration
    ).catch(() => {});
  }
});

function clearSettingsForTopFrame(details) {
  if (details.frameId === 0) {
    lastPauseAlertTime.delete(details.tabId);
    clearTabSettings(details.tabId).catch(() => {});
  }
}

// Clear before a replacement document can inherit the previous page's controls.
chrome.webNavigation.onBeforeNavigate.addListener(clearSettingsForTopFrame);
chrome.webNavigation.onCommitted.addListener(clearSettingsForTopFrame);
chrome.webNavigation.onHistoryStateUpdated.addListener(clearSettingsForTopFrame);

chrome.tabs.onRemoved.addListener((tabId) => {
  lastPauseAlertTime.delete(tabId);
  clearTabSettings(tabId).catch(() => {});
});
