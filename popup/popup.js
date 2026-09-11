const statusCard = document.querySelector("#status-card");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const detailText = document.querySelector("#detail-text");
const headerBadge = document.querySelector("#header-badge");
const toggleButton = document.querySelector("#toggle-button");
const playbackRateSelect = document.querySelector("#playback-rate");
const systemReminderToggle = document.querySelector("#system-reminder-toggle");
const mailReminderToggle = document.querySelector("#mail-reminder-toggle");
const continuousPlayToggle = document.querySelector("#continuous-play-toggle");
const skipWatchedToggle = document.querySelector("#skip-watched-toggle");
const qqMailSettings = document.querySelector("#qq-mail-settings");
const qqRecipientInput = document.querySelector("#qq-recipient");
const bridgeTokenInput = document.querySelector("#bridge-token");
const toggleTokenVisibilityButton = document.querySelector("#toggle-token-visibility");
const saveQqMailSettingsButton = document.querySelector("#save-qq-mail-settings");
const testQqMailButton = document.querySelector("#test-qq-mail");
const qqMailStatus = document.querySelector("#qq-mail-status");
const catalogList = document.querySelector("#catalog-list");
const catalogStatus = document.querySelector("#catalog-status");
const catalogStats = document.querySelector("#catalog-stats");
const refreshCatalogButton = document.querySelector("#refresh-catalog");
const copyDebugLogButton = document.querySelector("#copy-debug-log");
const authorToggle = document.querySelector("#author-toggle");
const authorPanel = document.querySelector("#author-panel");
const copyFeedbackEmailButton = document.querySelector("#copy-feedback-email");

const DEFAULT_REMINDER_SETTINGS = {
  mode: "system",
  qqMail: {
    recipient: "",
    bridgeToken: ""
  },
  qqMailConfigured: false
};

let currentTabId = null;
let currentStatus = { enabled: false, supported: false, playbackRate: 1, continuousPlay: true, skipWatched: true };
let currentReminderSettings = DEFAULT_REMINDER_SETTINGS;

function modeUsesQqMail(mode) {
  return mode === "qqmail" || mode === "both";
}

function selectedReminderMode() {
  if (systemReminderToggle.checked && mailReminderToggle.checked) return "both";
  if (systemReminderToggle.checked) return "system";
  if (mailReminderToggle.checked) return "qqmail";
  return "none";
}

function getQqMailSettingsFromForm() {
  return {
    recipient: qqRecipientInput.value.trim(),
    bridgeToken: bridgeTokenInput.value.trim()
  };
}

function isValidEmail(value) {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value);
}

function setQqMailBusy(isBusy) {
  systemReminderToggle.disabled = isBusy;
  mailReminderToggle.disabled = isBusy;
  saveQqMailSettingsButton.disabled = isBusy;
  testQqMailButton.disabled = isBusy;
}

function renderReminderSettings(settings, message) {
  currentReminderSettings = {
    ...DEFAULT_REMINDER_SETTINGS,
    ...settings,
    qqMail: { ...DEFAULT_REMINDER_SETTINGS.qqMail, ...settings?.qqMail }
  };

  systemReminderToggle.checked = currentReminderSettings.mode === "system" || currentReminderSettings.mode === "both";
  mailReminderToggle.checked = currentReminderSettings.mode === "qqmail" || currentReminderSettings.mode === "both";
  continuousPlayToggle.checked = currentStatus.continuousPlay === true;
  skipWatchedToggle.checked = currentStatus.skipWatched === true;

  // 保护正在输入的字段，避免被周期性状态刷新覆盖
  if (document.activeElement !== qqRecipientInput) {
    qqRecipientInput.value = currentReminderSettings.qqMail.recipient || "";
  }
  if (document.activeElement !== bridgeTokenInput) {
    bridgeTokenInput.value = currentReminderSettings.qqMail.bridgeToken || "";
  }

  qqMailSettings.hidden = !modeUsesQqMail(currentReminderSettings.mode);

  if (!modeUsesQqMail(currentReminderSettings.mode)) {
    qqMailStatus.textContent = "";
    qqMailStatus.style.color = "";
  } else if (message) {
    qqMailStatus.textContent = message;
    qqMailStatus.style.color = message.startsWith("✓") ? "#059669" : "#dc2626";
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
  continuousPlayToggle.checked = currentStatus.continuousPlay === true;
  skipWatchedToggle.checked = currentStatus.skipWatched === true;

  statusDot.classList.toggle("active", isEnabled);
  statusDot.classList.toggle("unsupported", !isSupported);
  statusCard.classList.toggle("active", isEnabled);
  statusCard.classList.toggle("unsupported", !isSupported);

  playbackRateSelect.value = String(currentRate);
  playbackRateSelect.disabled = !isSupported;
  continuousPlayToggle.disabled = !isSupported;
  skipWatchedToggle.disabled = !isSupported;

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
    detailText.textContent = detail || "视频结束时将发送提醒，并保持播放不中断。";
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

function renderCatalog(items, message) {
  catalogList.replaceChildren();
  if (!items?.length) {
    catalogList.hidden = true;
    catalogStats.hidden = true;
    catalogStatus.textContent = message || "未识别到目录；请抓取调试日志以便适配页面。";
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const row = document.createElement("li");
    row.className = "catalog-item";
    if (item.active) row.classList.add("active");
    if (item.completed) row.classList.add("completed");
    const label = document.createElement("button");
    label.type = "button";
    label.className = "catalog-item-title";
    label.textContent = item.title;
    label.addEventListener("click", async () => {
      label.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({
          type: "PLAY_CATALOG_ITEM",
          tabId: currentTabId,
          item: { title: item.title, path: item.path }
        });
        if (!result?.success) {
          catalogStatus.textContent = result?.error || "无法打开对应视频。";
        }
      } catch {
        catalogStatus.textContent = "无法打开对应视频，请重试。";
      } finally {
        label.disabled = false;
      }
    });
    const order = document.createElement("span");
    order.className = "catalog-item-order";
    order.textContent = String(index + 1);
    const content = document.createElement("div");
    content.className = "catalog-item-content";
    content.append(label);
    if (item.path?.length || item.status) {
      const meta = document.createElement("span");
      meta.className = "catalog-item-meta";
      meta.textContent = [...(item.path || []), item.status].filter(Boolean).join(" · ");
      content.append(meta);
    }
    row.append(order, content);
    fragment.append(row);
  });
  catalogList.append(fragment);
  catalogList.hidden = false;
  const completedCount = items.filter((item) => item.completed).length;
  catalogStats.textContent = `总计 ${items.length} · 已播放 ${completedCount} · 剩余 ${items.length - completedCount}`;
  catalogStats.hidden = false;
  catalogStatus.textContent = "点击课时即可切换并播放。";
}

async function loadCatalog(forceRefresh = false) {
  if (currentTabId === null) return;
  refreshCatalogButton.disabled = true;
  catalogStatus.textContent = forceRefresh ? "正在重新解析页面目录..." : "正在读取页面目录...";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "GET_PAGE_CATALOG",
      tabId: currentTabId,
      forceRefresh
    });
    if (!result?.success) throw new Error(result?.error || "目录解析失败。");
    renderCatalog(result.items);
  } catch (error) {
    renderCatalog([], error instanceof Error ? error.message : "目录解析失败。");
  } finally {
    refreshCatalogButton.disabled = false;
  }
}

async function saveReminderSettings(validateQqMailSettings) {
  const mode = selectedReminderMode();
  const formMail = getQqMailSettingsFromForm();

  let qqMailToSave;

  if (validateQqMailSettings && modeUsesQqMail(mode)) {
    if (!formMail.recipient) {
      qqMailStatus.textContent = "请填写收件人邮箱地址。";
      qqMailStatus.style.color = "#dc2626";
      qqRecipientInput.focus();
      return false;
    }
    if (!isValidEmail(formMail.recipient)) {
      qqMailStatus.textContent = "邮箱地址格式不正确，请输入有效的邮箱（如 123456@qq.com）。";
      qqMailStatus.style.color = "#dc2626";
      qqRecipientInput.focus();
      return false;
    }
    if (!formMail.bridgeToken) {
      qqMailStatus.textContent = "请从 PowerShell 窗口复制并填写桥接服务连接密钥。";
      qqMailStatus.style.color = "#dc2626";
      bridgeTokenInput.focus();
      return false;
    }
    qqMailToSave = formMail;
  } else {
    // 切换提醒模式时，若表单尚未保存，优先保留已存储的有效凭据
    qqMailToSave = (formMail.recipient && formMail.bridgeToken)
      ? formMail
      : currentReminderSettings.qqMail;
  }

  setQqMailBusy(true);
  try {
    const settings = await chrome.runtime.sendMessage({
      type: "SAVE_REMINDER_SETTINGS",
      mode,
      qqMail: qqMailToSave
    });

    if (!settings || settings.success === false) {
      throw new Error(settings?.error || "无法保存提醒设置。");
    }

    renderReminderSettings(
      settings,
      validateQqMailSettings ? "✓ 配置已成功保存！" : undefined
    );
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
    setStatus(status || { enabled: false, supported: false }, status?.error || status?.playbackStart);
  } catch {
    setStatus(currentStatus, "更新失败，请重试。");
  }
});

async function applyPlaybackRate(rate) {
  if (currentTabId === null || !currentStatus.supported) {
    return;
  }

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
  const rate = Number(playbackRateSelect.value);
  if (!Number.isFinite(rate) || rate < 0.1 || rate > 16) {
    playbackRateSelect.value = String(currentStatus.playbackRate || 1);
    detailText.textContent = "倍速范围为 0.1x - 16x。";
    return;
  }
  applyPlaybackRate(rate);
});

function handleReminderModeChange() {
  qqMailSettings.hidden = !modeUsesQqMail(selectedReminderMode());
  saveReminderSettings(false);
}

systemReminderToggle.addEventListener("change", handleReminderModeChange);
mailReminderToggle.addEventListener("change", handleReminderModeChange);

async function saveCatalogOptions() {
  continuousPlayToggle.disabled = true;
  skipWatchedToggle.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({
      type: "SET_CATALOG_OPTIONS",
      tabId: currentTabId,
      continuousPlay: continuousPlayToggle.checked,
      skipWatched: skipWatchedToggle.checked
    });
    setStatus(status || currentStatus, status?.error);
  } catch {
    catalogStatus.textContent = "目录播放设置保存失败，请重试。";
  } finally {
    const enabled = Boolean(currentStatus.supported);
    continuousPlayToggle.disabled = !enabled;
    skipWatchedToggle.disabled = !enabled;
  }
}

continuousPlayToggle.addEventListener("change", saveCatalogOptions);
skipWatchedToggle.addEventListener("change", saveCatalogOptions);

// 保存设置按钮
saveQqMailSettingsButton.addEventListener("click", () => {
  saveReminderSettings(true);
});

// 回车快捷保存
qqRecipientInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveReminderSettings(true);
});
bridgeTokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveReminderSettings(true);
});

// 密钥可见性切换 (明文/密文)
toggleTokenVisibilityButton?.addEventListener("click", () => {
  const isPassword = bridgeTokenInput.type === "password";
  bridgeTokenInput.type = isPassword ? "text" : "password";
  toggleTokenVisibilityButton.title = isPassword ? "隐藏密钥" : "显示密钥";
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
loadStatus().then(loadCatalog);
refreshCatalogButton.addEventListener("click", () => loadCatalog(true));
copyDebugLogButton.addEventListener("click", async () => {
  if (currentTabId === null) return;
  copyDebugLogButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "GET_PLAYBACK_DEBUG_LOG",
      tabId: currentTabId
    });
    if (!result?.success) throw new Error(result?.error || "读取日志失败。");
    await navigator.clipboard.writeText(result.text || "");
    catalogStatus.textContent = result.text?.includes('"event"')
      ? "调试日志已复制，请直接发给开发者。"
      : "暂无完播调试日志，请先复现一次问题。";
  } catch (error) {
    catalogStatus.textContent = error instanceof Error ? error.message : "复制日志失败，请重试。";
  } finally {
    copyDebugLogButton.disabled = false;
  }
});
authorToggle.addEventListener("click", () => {
  const expanded = authorToggle.getAttribute("aria-expanded") === "true";
  authorToggle.setAttribute("aria-expanded", String(!expanded));
  authorPanel.hidden = expanded;
});

copyFeedbackEmailButton.addEventListener("click", async () => {
  const email = "leezk2023jj@gmail.com";
  try {
    await navigator.clipboard.writeText(email);
    const detail = copyFeedbackEmailButton.querySelector(".author-link-detail");
    if (detail) {
      detail.textContent = "已复制";
      setTimeout(() => {
        detail.textContent = email;
      }, 1600);
    }
  } catch {
    // Clipboard access can be unavailable in some browser contexts; avoid
    // falling back to mailto so clicking never launches a mail client.
  }
});
