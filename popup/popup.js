const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const toggleButton = document.querySelector("#toggle-button");
const detailText = document.querySelector("#detail-text");
const playbackRateSelect = document.querySelector("#playback-rate");
const reminderModeSelect = document.querySelector("#reminder-mode");
const qqMailSettings = document.querySelector("#qq-mail-settings");
const qqRecipientInput = document.querySelector("#qq-recipient");
const bridgeTokenInput = document.querySelector("#bridge-token");
const saveQqMailSettingsButton = document.querySelector("#save-qq-mail-settings");
const testQqMailButton = document.querySelector("#test-qq-mail");
const qqMailStatus = document.querySelector("#qq-mail-status");

const DEFAULT_REMINDER_SETTINGS = {
  mode: "system",
  qqMail: {
    recipient: "",
    bridgeToken: ""
  },
  qqMailConfigured: false
};

let currentTabId = null;
let currentStatus = { enabled: false, supported: false, playbackRate: 1 };
let currentReminderSettings = DEFAULT_REMINDER_SETTINGS;

function modeUsesQqMail(mode) {
  return mode === "qqmail" || mode === "both";
}

function getQqMailSettingsFromForm() {
  return {
    recipient: qqRecipientInput.value.trim(),
    bridgeToken: bridgeTokenInput.value.trim()
  };
}

function isQqMailbox(value) {
  return /^[1-9]\d{4,12}@qq\.com$/i.test(value);
}

function setQqMailBusy(isBusy) {
  reminderModeSelect.disabled = isBusy;
  saveQqMailSettingsButton.disabled = isBusy;
  testQqMailButton.disabled = isBusy;
}

function renderReminderSettings(settings, message) {
  currentReminderSettings = {
    ...DEFAULT_REMINDER_SETTINGS,
    ...settings,
    qqMail: { ...DEFAULT_REMINDER_SETTINGS.qqMail, ...settings?.qqMail }
  };

  reminderModeSelect.value = currentReminderSettings.mode;
  qqRecipientInput.value = currentReminderSettings.qqMail.recipient;
  bridgeTokenInput.value = currentReminderSettings.qqMail.bridgeToken;
  qqMailSettings.hidden = !modeUsesQqMail(currentReminderSettings.mode);

  if (!modeUsesQqMail(currentReminderSettings.mode)) {
    qqMailStatus.textContent = "";
  } else if (message) {
    qqMailStatus.textContent = message;
  } else if (currentReminderSettings.qqMailConfigured) {
    qqMailStatus.textContent = "QQ 邮箱设置已保存。";
  } else {
    qqMailStatus.textContent = "请填写 QQ 邮箱和连接密钥。";
  }
}

function setStatus(status, detail) {
  currentStatus = { ...currentStatus, ...status };
  statusDot.classList.toggle("active", currentStatus.enabled);
  statusDot.classList.toggle("unsupported", !currentStatus.supported);
  playbackRateSelect.value = String(currentStatus.playbackRate || 1);
  playbackRateSelect.disabled = !currentStatus.supported;

  if (status.reminderSettings) {
    renderReminderSettings(status.reminderSettings);
  }

  if (!currentStatus.supported) {
    statusText.textContent = "此页面不支持控制";
    detailText.textContent = detail || "请在普通网页中打开扩展。";
    toggleButton.textContent = "无法监测";
    toggleButton.disabled = true;
    toggleButton.classList.remove("stop");
    return;
  }

  statusText.textContent = currentStatus.enabled
    ? "正在监测此页面的视频"
    : "尚未开始监测";
  detailText.textContent = detail || "视频结束后将按所选方式提醒。";
  toggleButton.textContent = currentStatus.enabled ? "停止监测" : "开始监测";
  toggleButton.disabled = false;
  toggleButton.classList.toggle("stop", currentStatus.enabled);
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadStatus() {
  try {
    const tab = await getCurrentTab();
    currentTabId = tab?.id ?? null;

    if (currentTabId === null) {
      setStatus({ enabled: false, supported: false }, "未找到可控制的标签页。");
      return;
    }

    const status = await chrome.runtime.sendMessage({
      type: "GET_TAB_STATUS",
      tabId: currentTabId
    });
    setStatus(status || { enabled: false, supported: false });
  } catch {
    setStatus({ enabled: false, supported: false }, "无法读取当前标签页状态。");
  }
}

async function saveReminderSettings(validateQqMailSettings) {
  const mode = reminderModeSelect.value;
  const qqMail = getQqMailSettingsFromForm();

  if (validateQqMailSettings && modeUsesQqMail(mode)) {
    if (!isQqMailbox(qqMail.recipient) || !qqMail.bridgeToken) {
      qqMailStatus.textContent = "请填写有效的 QQ 邮箱和连接密钥。";
      return false;
    }
  }

  setQqMailBusy(true);
  try {
    const settings = await chrome.runtime.sendMessage({
      type: "SAVE_REMINDER_SETTINGS",
      mode,
      qqMail
    });

    if (!settings || settings.success === false) {
      throw new Error(settings?.error || "无法保存提醒设置。");
    }
    renderReminderSettings(settings);
    return true;
  } catch (error) {
    qqMailStatus.textContent = error instanceof Error ? error.message : "保存失败，请重试。";
    return false;
  } finally {
    setQqMailBusy(false);
  }
}

toggleButton.addEventListener("click", async () => {
  if (toggleButton.disabled || currentTabId === null) {
    return;
  }

  toggleButton.disabled = true;
  detailText.textContent = "正在更新监测状态...";

  try {
    const status = await chrome.runtime.sendMessage({
      type: "SET_TRACKING",
      tabId: currentTabId,
      enabled: !currentStatus.enabled
    });
    setStatus(status || { enabled: false, supported: false }, status?.error);
  } catch {
    setStatus(currentStatus, "更新失败，请重试。");
  }
});

playbackRateSelect.addEventListener("change", async () => {
  if (currentTabId === null || !currentStatus.supported) {
    return;
  }

  playbackRateSelect.disabled = true;
  detailText.textContent = "正在设置播放倍速...";

  try {
    const status = await chrome.runtime.sendMessage({
      type: "SET_PLAYBACK_RATE",
      tabId: currentTabId,
      playbackRate: Number(playbackRateSelect.value)
    });
    setStatus(status || currentStatus, status?.error);
  } catch {
    setStatus(currentStatus, "设置播放倍速失败，请重试。");
  }
});

reminderModeSelect.addEventListener("change", () => {
  saveReminderSettings(false);
});

saveQqMailSettingsButton.addEventListener("click", () => {
  saveReminderSettings(true);
});

testQqMailButton.addEventListener("click", async () => {
  if (!(await saveReminderSettings(true))) {
    return;
  }

  setQqMailBusy(true);
  qqMailStatus.textContent = "正在发送测试邮件...";
  try {
    const result = await chrome.runtime.sendMessage({ type: "SEND_TEST_QQ_MAIL" });
    if (!result?.success) {
      throw new Error(result?.error || "测试邮件发送失败。");
    }
    qqMailStatus.textContent = "测试邮件已发送，请查看 QQ 邮箱。";
  } catch (error) {
    qqMailStatus.textContent = error instanceof Error ? error.message : "测试邮件发送失败。";
  } finally {
    setQqMailBusy(false);
  }
});

renderReminderSettings(DEFAULT_REMINDER_SETTINGS);
loadStatus();
