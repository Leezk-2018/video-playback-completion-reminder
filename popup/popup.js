const statusCard = document.querySelector("#status-card");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const detailText = document.querySelector("#detail-text");
const headerBadge = document.querySelector("#header-badge");
const toggleButton = document.querySelector("#toggle-button");
const playbackRateSelect = document.querySelector("#playback-rate");
const rateChips = document.querySelectorAll(".rate-chip");
const reminderModeSelect = document.querySelector("#reminder-mode");
const pauseReminderToggle = document.querySelector("#pause-reminder-toggle");
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
  qqMailConfigured: false,
  pauseReminder: true
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
  pauseReminderToggle.disabled = isBusy;
  saveQqMailSettingsButton.disabled = isBusy;
  testQqMailButton.disabled = isBusy;
}

function updateRateChips(currentRate, supported) {
  const normalizedRate = Number(currentRate || 1);
  rateChips.forEach((chip) => {
    const chipRate = Number(chip.dataset.rate);
    chip.classList.toggle("active", chipRate === normalizedRate);
    chip.disabled = !supported;
  });
}

function renderReminderSettings(settings, message) {
  currentReminderSettings = {
    ...DEFAULT_REMINDER_SETTINGS,
    ...settings,
    qqMail: { ...DEFAULT_REMINDER_SETTINGS.qqMail, ...settings?.qqMail }
  };

  reminderModeSelect.value = currentReminderSettings.mode;
  pauseReminderToggle.checked = currentReminderSettings.pauseReminder !== false;
  qqRecipientInput.value = currentReminderSettings.qqMail.recipient;
  bridgeTokenInput.value = currentReminderSettings.qqMail.bridgeToken;
  qqMailSettings.hidden = !modeUsesQqMail(currentReminderSettings.mode);

  if (!modeUsesQqMail(currentReminderSettings.mode)) {
    qqMailStatus.textContent = "";
    qqMailStatus.style.color = "";
  } else if (message) {
    qqMailStatus.textContent = message;
    qqMailStatus.style.color = "";
  } else if (currentReminderSettings.qqMailConfigured) {
    qqMailStatus.textContent = "✓ QQ 邮箱已配置完成，随时可发信。";
    qqMailStatus.style.color = "#059669";
  } else {
    qqMailStatus.textContent = "请填写 QQ 邮箱和连接密钥。";
    qqMailStatus.style.color = "#d97706";
  }
}

function setStatus(status, detail) {
  currentStatus = { ...currentStatus, ...status };

  const isSupported = Boolean(currentStatus.supported);
  const isEnabled = Boolean(currentStatus.enabled);
  const currentRate = Number(currentStatus.playbackRate || 1);

  statusDot.classList.toggle("active", isEnabled);
  statusDot.classList.toggle("unsupported", !isSupported);
  statusCard.classList.toggle("active", isEnabled);
  statusCard.classList.toggle("unsupported", !isSupported);

  playbackRateSelect.value = String(currentRate);
  playbackRateSelect.disabled = !isSupported;
  updateRateChips(currentRate, isSupported);

  if (status.reminderSettings) {
    renderReminderSettings(status.reminderSettings);
  }

  if (!isSupported) {
    headerBadge.textContent = "不可用";
    headerBadge.className = "header-badge unsupported";
    statusText.textContent = "此页面不支持控制";
    detailText.textContent = detail || "请在包含 HTML5 视频的普通网页中打开。";
    toggleButton.textContent = "无法监测";
    toggleButton.disabled = true;
    toggleButton.classList.remove("stop");
    return;
  }

  if (isEnabled) {
    headerBadge.textContent = "监测中";
    headerBadge.className = "header-badge active";
    statusText.textContent = "正在监测此页面的视频";
    detailText.textContent = detail || "视频结束或异常暂停时将发送提醒。";
    toggleButton.textContent = "停止监测";
    toggleButton.disabled = false;
    toggleButton.classList.add("stop");
  } else {
    headerBadge.textContent = "待命";
    headerBadge.className = "header-badge";
    statusText.textContent = "尚未开始监测";
    detailText.textContent = detail || "点击下方按钮开始监测播放状态。";
    toggleButton.textContent = "开始监测";
    toggleButton.disabled = false;
    toggleButton.classList.remove("stop");
  }
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
  const pauseReminder = pauseReminderToggle.checked;

  if (validateQqMailSettings && modeUsesQqMail(mode)) {
    if (!isQqMailbox(qqMail.recipient) || !qqMail.bridgeToken) {
      qqMailStatus.textContent = "请填写有效的 QQ 邮箱和连接密钥。";
      qqMailStatus.style.color = "#dc2626";
      return false;
    }
  }

  setQqMailBusy(true);
  try {
    const settings = await chrome.runtime.sendMessage({
      type: "SAVE_REMINDER_SETTINGS",
      mode,
      qqMail,
      pauseReminder
    });

    if (!settings || settings.success === false) {
      throw new Error(settings?.error || "无法保存提醒设置。");
    }
    renderReminderSettings(settings);
    return true;
  } catch (error) {
    qqMailStatus.textContent = error instanceof Error ? error.message : "保存失败，请重试。";
    qqMailStatus.style.color = "#dc2626";
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

async function applyPlaybackRate(rate) {
  if (currentTabId === null || !currentStatus.supported) {
    return;
  }

  rateChips.forEach((chip) => (chip.disabled = true));
  playbackRateSelect.disabled = true;
  detailText.textContent = "正在设置播放倍速...";

  try {
    const status = await chrome.runtime.sendMessage({
      type: "SET_PLAYBACK_RATE",
      tabId: currentTabId,
      playbackRate: rate
    });
    setStatus(status || currentStatus, status?.error);
  } catch {
    setStatus(currentStatus, "设置播放倍速失败，请重试。");
  }
}

playbackRateSelect.addEventListener("change", () => {
  applyPlaybackRate(Number(playbackRateSelect.value));
});

rateChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    if (chip.disabled) return;
    const rate = Number(chip.dataset.rate);
    playbackRateSelect.value = String(rate);
    applyPlaybackRate(rate);
  });
});

reminderModeSelect.addEventListener("change", () => {
  qqMailSettings.hidden = !modeUsesQqMail(reminderModeSelect.value);
  saveReminderSettings(false);
});

pauseReminderToggle.addEventListener("change", async () => {
  await saveReminderSettings(false);
  if (currentTabId !== null && currentStatus.supported && currentStatus.enabled) {
    chrome.scripting.executeScript({
      target: { tabId: currentTabId, allFrames: true },
      files: ["content.js"]
    }).catch(() => {});
  }
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
  qqMailStatus.style.color = "#0f766e";
  try {
    const result = await chrome.runtime.sendMessage({ type: "SEND_TEST_QQ_MAIL" });
    if (!result?.success) {
      throw new Error(result?.error || "测试邮件发送失败。");
    }
    qqMailStatus.textContent = "✓ 测试邮件已发送，请查看 QQ 邮箱。";
    qqMailStatus.style.color = "#059669";
  } catch (error) {
    qqMailStatus.textContent = error instanceof Error ? error.message : "测试邮件发送失败。";
    qqMailStatus.style.color = "#dc2626";
  } finally {
    setQqMailBusy(false);
  }
});

renderReminderSettings(DEFAULT_REMINDER_SETTINGS);
loadStatus();
