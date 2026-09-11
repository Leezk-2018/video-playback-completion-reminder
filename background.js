const TAB_SESSION_KEY_PREFIX = "tab-settings:";
const REMINDER_SETTINGS_KEY = "reminder-settings";
const CATALOG_CACHE_KEY_PREFIX = "catalog-cache:";
const CATALOG_CACHE_VERSION = 3;
const PLAYBACK_DEBUG_KEY_PREFIX = "playback-debug:";
const PLAYBACK_DEBUG_EVENT_PREFIX = "PLAYBACK_DEBUG:";
const PLAYBACK_DEBUG_LIMIT = 200;
const catalogCache = new Map();
const NOTIFICATION_ICON = "icons/icon128.png";
const QQ_MAIL_BRIDGE_URL = "http://127.0.0.1:8787/send";
const REMINDER_MODES = new Set(["none", "system", "qqmail", "both"]);

const DEFAULT_TAB_SETTINGS = Object.freeze({
  enabled: false,
  playbackRate: 1,
  continuousPlay: true,
  skipWatched: true
});

const DEFAULT_REMINDER_SETTINGS = Object.freeze({
  mode: "system",
  qqMail: Object.freeze({
    recipient: "",
    bridgeToken: ""
  })
});

function tabSessionKey(tabId) {
  return `${TAB_SESSION_KEY_PREFIX}${tabId}`;
}

function catalogCacheKey(tabId) {
  return `${CATALOG_CACHE_KEY_PREFIX}${tabId}`;
}

function playbackDebugKey(tabId) {
  return `${PLAYBACK_DEBUG_KEY_PREFIX}${tabId}`;
}

async function appendPlaybackDebugLog(tabId, event, details = {}) {
  if (!Number.isInteger(tabId)) return;
  const entry = {
    time: new Date().toISOString(),
    event: `${PLAYBACK_DEBUG_EVENT_PREFIX}${event}`,
    details
  };

  try {
    const key = playbackDebugKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const entries = Array.isArray(stored[key]) ? stored[key] : [];
    entries.push(entry);
    await chrome.storage.session.set({ [key]: entries.slice(-PLAYBACK_DEBUG_LIMIT) });
  } catch {
    // Diagnostics must never interrupt completion or continuous playback.
  }
}

async function getPlaybackDebugLog(tabId) {
  const key = playbackDebugKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const entries = Array.isArray(stored[key]) ? stored[key] : [];
  return {
    success: true,
    text: JSON.stringify({
      generatedAt: new Date().toISOString(),
      tabId,
      entries
    }, null, 2)
  };
}

async function clearPlaybackDebugLog(tabId) {
  await chrome.storage.session.remove(playbackDebugKey(tabId));
}

function summarizeCatalog(items = [], startOrder = 1) {
  return items.map((item, index) => ({
    order: startOrder + index,
    title: item.title,
    path: item.path || [],
    status: item.status || "",
    active: item.active === true,
    completed: item.completed === true,
    frameId: item.frameId
  }));
}

function summarizeCatalogWindow(items = [], centerIndex = -1, radius = 2) {
  if (!items.length) return [];
  const safeCenter = centerIndex >= 0 ? centerIndex : 0;
  const start = Math.max(0, safeCenter - radius);
  const end = Math.min(items.length, safeCenter + radius + 1);
  return summarizeCatalog(items.slice(start, end), start + 1);
}

function summarizeActiveCatalogItems(items = []) {
  return items.flatMap((item, index) =>
    item.active ? summarizeCatalog([item], index + 1) : []
  );
}

function sanitizeDebugUrl(value) {
  if (typeof value === "string" && value.startsWith("blob:")) return "blob:[redacted]";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return typeof value === "string" && value.startsWith("blob:") ? "blob:[redacted]" : "";
  }
}

async function getCachedCatalog(tabId) {
  const inMemory = catalogCache.get(tabId);
  if (inMemory) return inMemory;

  const key = catalogCacheKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const cached = stored[key];
  if (!cached || typeof cached.url !== "string" || !Array.isArray(cached.items)) return null;
  catalogCache.set(tabId, cached);
  return cached;
}

async function saveCachedCatalog(tabId, cached) {
  catalogCache.set(tabId, cached);
  await chrome.storage.session.set({ [catalogCacheKey(tabId)]: cached });
}

async function clearCachedCatalog(tabId) {
  catalogCache.delete(tabId);
  await chrome.storage.session.remove(catalogCacheKey(tabId));
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
  if (!Number.isFinite(playbackRate) || playbackRate < 0.1 || playbackRate > 16) {
    return 1;
  }
  return Math.round(playbackRate * 100) / 100;
}

function normalizeTabSettings(value) {
  return {
    enabled: value?.enabled === true,
    playbackRate: normalizePlaybackRate(value?.playbackRate),
    continuousPlay: value?.continuousPlay !== false,
    skipWatched: value?.skipWatched !== false
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
  };
}

function isQqMailConfigured(settings) {
  const { recipient, bridgeToken } = settings?.qqMail || {};
  return Boolean(recipient && bridgeToken);
}

function withReminderMetadata(settings) {
  return {
    success: true,
    ...settings,
    qqMailConfigured: isQqMailConfigured(settings)
  };
}

async function getTabSettings(tabId) {
  if (!Number.isInteger(tabId)) {
    return { ...DEFAULT_TAB_SETTINGS };
  }

  const key = tabSessionKey(tabId);
  const [savedState, reminderSettings] = await Promise.all([
    chrome.storage.session.get(key),
    getReminderSettings()
  ]);
  return {
    ...normalizeTabSettings(savedState[key])
  };
}

async function saveTabSettings(tabId, settings) {
  const normalized = normalizeTabSettings(settings);
  const key = tabSessionKey(tabId);

  if (!normalized.enabled && normalized.playbackRate === 1 && !normalized.continuousPlay && !normalized.skipWatched) {
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
    qqMail: { ...current.qqMail, ...changes?.qqMail }
  });
  await chrome.storage.local.set({ [REMINDER_SETTINGS_KEY]: next });
  return withReminderMetadata(next);
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"]
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["page-hook.js"],
    world: "MAIN"
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

// This function is intentionally self-contained: chrome.scripting serializes it
// and runs it in every accessible frame of the active tab.
async function extractCatalogFromDocument() {
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const describe = (element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.split(/\s+/).slice(0, 3).join(".")}` : ""}`;
  const catalogPattern = /catalog|chapter|lesson|courseware|curriculum|outline|目录|章节|课时|课程|大纲/i;
  const rowPattern = /chapter|lesson|course|section|item|node|目录|章节|课时|课程/i;

  // 国家中小学智慧教育平台教师端的真实课程目录：资源项即实际可播放课时。
  // 样式模块 hash 会变化，因此只匹配稳定的 class 前缀。
  const exactCatalogRoot = document.querySelector('[class*="index-module_detail-main-r_"]');
  if (exactCatalogRoot) {
    // 该站点按层级懒渲染课时。逐层展开可以让尚未挂载的 resource-item
    // 出现在 DOM；读取完成后会恢复用户原先的折叠状态。
    const collapsedHeadersToRestore = new Set();
    let expandedCount = 0;
    for (let level = 0; level < 12; level += 1) {
      const collapsedHeaders = [...exactCatalogRoot.querySelectorAll('.fish-collapse-header[aria-expanded="false"]')];
      if (!collapsedHeaders.length) break;
      collapsedHeaders.forEach((header) => collapsedHeadersToRestore.add(header));
      collapsedHeaders.forEach((header) => header.click());
      expandedCount += collapsedHeaders.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const items = [...exactCatalogRoot.querySelectorAll(".resource-item")].map((resource) => {
      const title = normalizeText(resource.querySelector(":scope > div:first-child")?.textContent);
      const status = normalizeText(resource.querySelector(".status-icon [title]")?.getAttribute("title"));
      const path = [];
      let section = resource.closest(".fish-collapse-item");
      while (section && exactCatalogRoot.contains(section)) {
        const header = section.querySelector(":scope > .fish-collapse-header");
        const sectionTitle = normalizeText(header?.textContent);
        if (sectionTitle) path.unshift(sectionTitle);
        section = section.parentElement?.closest(".fish-collapse-item");
      }
      return {
        title,
        path,
        url: "",
        active: resource.classList.contains("resource-item-active") || status === "进行中",
        completed: status === "已学完",
        status: status || "未知状态",
        source: "smartedu-resource-item"
      };
    }).filter(({ title }) => title);
    const debug = {
      strategy: "smartedu-resource-item",
      url: location.href,
      title: document.title,
      root: describe(exactCatalogRoot),
      initiallyCollapsedCount: collapsedHeadersToRestore.size,
      expandedCount,
      itemCount: items.length,
      sample: items.slice(0, 10)
    };
    // 反向恢复：先收子级，再收父级，避免关闭父级时销毁仍待恢复的子节点。
    [...collapsedHeadersToRestore].reverse().forEach((header) => {
      if (header.isConnected && header.getAttribute("aria-expanded") === "true") header.click();
    });
    return { items, debug };
  }

  const candidates = [...document.querySelectorAll("[id], [class], [role='tree'], [role='list'], nav, aside")]
    .filter((element) => catalogPattern.test(`${element.id} ${typeof element.className === "string" ? element.className : ""} ${element.getAttribute("aria-label") || ""}`))
    .filter(isVisible)
    .map((element) => ({
      element,
      score: element.querySelectorAll("a, button, [role='treeitem'], li").length
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  const roots = candidates.length ? candidates.map(({ element }) => element) : [document.body];
  const rows = [];
  const seen = new Set();

  for (const root of roots) {
    const rowNodes = root.querySelectorAll("[role='treeitem'], [role='listitem'], li, a, button, [data-index], [data-id]");
    for (const node of rowNodes) {
      if (!isVisible(node)) continue;
      const classAndAttributes = `${node.id} ${typeof node.className === "string" ? node.className : ""} ${node.getAttribute("aria-label") || ""}`;
      const interactive = node.matches("a, button, [role='treeitem'], [role='listitem']") || rowPattern.test(classAndAttributes);
      if (!interactive) continue;

      const title = normalizeText(node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent);
      if (!title || title.length > 160 || /^(目录|章节|课时|课程)$/i.test(title)) continue;
      const link = node.closest("a") || node.querySelector("a");
      const url = link?.href || "";
      const dedupeKey = `${title}|${url}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const stateText = `${classAndAttributes} ${node.getAttribute("aria-current") || ""}`;
      rows.push({
        title,
        url,
        active: node.getAttribute("aria-current") === "true" || /active|current|selected|playing|正在播放|当前/.test(stateText),
        completed: /complete|finished|done|已学|已完成|已观看/.test(stateText),
        source: describe(node)
      });
      if (rows.length >= 100) break;
    }
    if (rows.length >= 100) break;
  }

  const debug = {
    url: location.href,
    title: document.title,
    candidateCount: candidates.length,
    candidates: candidates.map(({ element, score }) => ({ selector: describe(element), score })),
    itemCount: rows.length,
    sample: rows.slice(0, 10)
  };
  return { items: rows, debug };
}

async function getPageCatalog(tabId, forceRefresh = false) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab.url)) {
    return { success: false, error: "此页面不支持读取目录。", items: [] };
  }

  const cached = await getCachedCatalog(tabId);
  if (!forceRefresh && cached?.url === tab.url && cached.version === CATALOG_CACHE_VERSION) {
    return { success: true, items: cached.items, frames: cached.frames, lastCompletedTitle: cached.lastCompletedTitle || "", cached: true };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: extractCatalogFromDocument
  });
  const seen = new Set();
  const items = [];
  const frames = [];
  for (const entry of results) {
    const result = entry.result || { items: [], debug: {} };
    frames.push({ frameId: entry.frameId, ...result.debug });
    for (const item of result.items || []) {
      const key = `${item.title}|${item.url}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ ...item, frameId: entry.frameId });
      }
    }
  }
  const result = { success: true, items, frames, cached: false };
  await saveCachedCatalog(tabId, {
    version: CATALOG_CACHE_VERSION,
    url: tab.url,
    items,
    frames,
    lastCompletedTitle: ""
  });
  return result;
}

function catalogItemMatches(left, right) {
  if (!left || !right || left.title !== right.title) return false;
  const leftPath = Array.isArray(left.path) ? left.path : [];
  const rightPath = Array.isArray(right.path) ? right.path : [];
  return leftPath.length === rightPath.length && leftPath.every((part, index) => part === rightPath[index]);
}

async function updateCachedCatalogActiveItem(tabId, activeItem) {
  const cached = await getCachedCatalog(tabId);
  if (!cached || !activeItem?.title) return;
  let found = false;
  cached.items = cached.items.map((item) => {
    if (catalogItemMatches(item, activeItem) && !found) {
      found = true;
      return { ...item, active: true };
    }
    return item.active ? { ...item, active: false } : item;
  });
  await saveCachedCatalog(tabId, cached);
}

async function markCachedCatalogActiveItemCompleted(tabId, completedTitle = "") {
  const cached = await getCachedCatalog(tabId);
  if (!cached) return null;
  const matchingActiveItem = cached.items.find((item) =>
    item.active && item.title === completedTitle
  );
  const pageTitleItem = cached.items.find((item) => item.title === completedTitle);
  const activeItem = cached.items.find((item) => item.active);
  const lastCompletedItem = cached.items.find((item) => item.title === cached.lastCompletedTitle);
  // Manual navigation can leave an older item active in the cache. Prefer the
  // page's explicit active marker, then fall back to cached state.
  const targetItem = matchingActiveItem || pageTitleItem || activeItem || lastCompletedItem;
  if (!targetItem) return null;
  const catalogIndex = cached.items.indexOf(targetItem);
  cached.items = cached.items.map((item) => {
    if (item === targetItem) {
      cached.lastCompletedTitle = item.title;
      return { ...item, active: false, completed: true, status: "已学完" };
    }
    return item.active ? { ...item, active: false } : item;
  });
  if (!cached.lastCompletedTitle) cached.lastCompletedTitle = targetItem.title;
  await saveCachedCatalog(tabId, cached);
  return {
    title: targetItem.title,
    path: targetItem.path || [],
    catalogIndex,
    matchSource: matchingActiveItem
      ? "page-and-cache-active"
      : pageTitleItem
        ? "page-active-title"
        : activeItem
          ? "cached-active-fallback"
          : "last-completed-title"
  };
}

async function getActiveCatalogTitle(tabId) {
  const findActiveTitle = () => {
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const root = document.querySelector('[class*="index-module_detail-main-r_"]');
    if (!root) return "";
    const resources = [...root.querySelectorAll(".resource-item")];
    // The previous lesson can retain its "进行中" status after another item
    // becomes selected. The explicit active class is the authoritative marker.
    const active = resources.find((resource) => resource.classList.contains("resource-item-active")) ||
      resources.find((resource) => resource.querySelector('.status-icon [title="进行中"]'));
    return normalizeText(active?.querySelector(":scope > div:first-child")?.textContent);
  };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: findActiveTitle
    });
    return results.find((entry) => entry.result)?.result || "";
  } catch {
    return "";
  }
}

async function clickCatalogItemInDocument({ title, path } = {}) {
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const dismissCourseCreditNotice = () => {
    const hasCourseCreditMessage = (value) => {
      const text = String(value || "").replace(/\s+/g, "").trim();
      return text.includes("须学习完课程的视频") && text.includes("才可获得该课程视频的学时");
    };
    for (const modal of document.querySelectorAll(".fish-modal-content")) {
      const message = modal.querySelector(".fish-modal-confirm-content")?.textContent;
      if (!hasCourseCreditMessage(message)) continue;

      const confirmButton = [...modal.querySelectorAll(".fish-modal-confirm-btns button, .fish-modal-confirm-btns .fish-btn")]
        .find((button) => normalizeText(button.textContent).includes("我知道了"));
      if (confirmButton) {
        confirmButton.click();
        return true;
      }
    }
    return false;
  };
  const waitForPlayback = async (previousVideoSources = new Map(), isTargetActive = () => true) => {
    const deadline = Date.now() + 8_000;
    const switchDeadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      dismissCourseCreditNotice();
      if (!isTargetActive()) return false;
      const videos = [...document.querySelectorAll("video")];
      const switchedVideos = videos.filter((video) => {
        const previousSource = previousVideoSources.get(video);
        return previousSource === undefined || previousSource !== (video.currentSrc || video.src);
      });
      const pool = switchedVideos.length || Date.now() >= switchDeadline ? switchedVideos.length ? switchedVideos : videos : [];
      const candidates = pool.filter((video) => !video.ended && (video.readyState >= 2 || video.duration > 0));
      for (const video of candidates) {
        if (video.ended) continue;
        try {
          await video.play();
          return true;
        } catch {
          // Player may still be loading; retry after a short delay.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };
  const waitForResourceActivation = async (resource) => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const active = resource.classList.contains("resource-item-active") ||
        resource.querySelector('.status-icon [title="进行中"]');
      if (active) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  };
  const root = document.querySelector('[class*="index-module_detail-main-r_"]');
  if (!root || !title) return { success: false, reason: !root ? "catalog-root-not-found" : "title-missing" };

  // 目录是懒渲染的，点击前展开全部层级，确保目标资源已挂载。
  for (let level = 0; level < 12; level += 1) {
    const collapsed = [...root.querySelectorAll('.fish-collapse-header[aria-expanded="false"]')];
    if (!collapsed.length) break;
    collapsed.forEach((header) => header.click());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const resources = [...root.querySelectorAll(".resource-item")];
  const previousVideoSources = new Map(
    [...document.querySelectorAll("video")].map((video) => [video, video.currentSrc || video.src])
  );
  const target = resources.find((resource) => {
    const resourceTitle = normalizeText(resource.querySelector(":scope > div:first-child")?.textContent);
    if (resourceTitle !== title) return false;
    if (!Array.isArray(path) || !path.length) return true;
    const headers = [];
    let section = resource.closest(".fish-collapse-item");
    while (section && root.contains(section)) {
      headers.unshift(normalizeText(section.querySelector(":scope > .fish-collapse-header")?.textContent));
      section = section.parentElement?.closest(".fish-collapse-item");
    }
    return path.every((part, index) => headers[index] === part);
  });

  if (!target) {
    return {
      success: false,
      reason: "catalog-item-not-found",
      requestedTitle: title,
      requestedPath: path || [],
      resourceCount: resources.length,
      resourceTitles: resources.map((resource) =>
        normalizeText(resource.querySelector(":scope > div:first-child")?.textContent)
      )
    };
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.click();
  // The course player switches asynchronously after the catalog click. Wait
  // for its active marker when available, then leave a short render buffer.
  const activated = await waitForResourceActivation(target);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  dismissCourseCreditNotice();
  const hasExplicitActiveItem = () => resources.some((resource) =>
    resource.classList.contains("resource-item-active")
  );
  const isTargetActive = () => target.classList.contains("resource-item-active") ||
    (!hasExplicitActiveItem() && Boolean(target.querySelector('.status-icon [title="进行中"]')));
  const played = await waitForPlayback(previousVideoSources, isTargetActive);
  const targetActive = isTargetActive();
  return {
    success: played && targetActive,
    title,
    played,
    activated,
    targetActive,
    matchedResourceIndex: resources.indexOf(target),
    resourceCount: resources.length
  };
}

async function playCatalogItem(tabId, item) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab.url)) return { success: false, error: "此页面不支持播放目录视频。" };
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: clickCatalogItemInDocument,
      args: [item]
    });
    attempts.push({
      attempt,
      frameResults: results.map((entry) => ({ frameId: entry.frameId, result: entry.result || null }))
    });
    const result = results.find((entry) => entry.result?.success)?.result;
    if (result?.success) {
      await updateCachedCatalogActiveItem(tabId, item);
      return { ...result, attempt };
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    success: false,
    error: "未找到对应的视频目录项。",
    attempts
  };
}

// Start the video already shown on the page when catalog skipping is disabled.
// The content script also resumes videos, but that bootstrap is asynchronous;
// doing this explicitly avoids a race immediately after enabling monitoring.
async function playCurrentPageVideos(tabId) {
  const playVideosInDocument = async () => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const videos = [...document.querySelectorAll("video")];
      const candidates = videos.filter((video) =>
        !video.ended && (video.readyState >= 2 || video.duration > 0)
      );
      for (const video of candidates) {
        try {
          await video.play();
          return { success: true, videoCount: videos.length };
        } catch {
          // Retry while the player is loading or switching sources.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { success: false, videoCount: document.querySelectorAll("video").length };
  };

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: playVideosInDocument
  });
  return results.find((entry) => entry.result?.success)?.result || {
    success: false,
    videoCount: results.reduce((count, entry) => count + (entry.result?.videoCount || 0), 0)
  };
}

async function startMonitoringPlayback(tabId) {
  const status = await updateCurrentTabSettings(tabId, { enabled: true });
  if (!status.success) {
    return status;
  }
  if (!status.skipWatched) {
    const playback = await playCurrentPageVideos(tabId).catch(() => ({ success: false }));
    return {
      ...status,
      playbackStart: playback.success ? "已开始播放当前页视频。" : "未能自动播放当前页视频，请手动点击播放。"
    };
  }

  try {
    // Refresh before choosing so the first unfinished item reflects the page,
    // rather than a possibly stale popup cache.
    const catalog = await getPageCatalog(tabId, true);
    const firstUnwatchedItem = catalog.items?.find((item) => item.completed !== true);
    if (!firstUnwatchedItem) {
      return { ...status, playbackStart: "当前目录没有待播放视频，已继续播放当前页视频。" };
    }

    const result = await playCatalogItem(tabId, firstUnwatchedItem);
    if (result?.success && result.played) {
      return { ...status, playbackStart: `已开始播放：${firstUnwatchedItem.title}` };
    }

    return { ...status, playbackStart: "未能切换目录视频，已继续播放当前页视频。" };
  } catch {
    return { ...status, playbackStart: "目录读取失败，已继续播放当前页视频。" };
  }
}

const catalogAdvanceLocks = new Map();
async function advanceCatalogPlayback(tabId, skipWatched, completedItem = null) {
  if (catalogAdvanceLocks.get(tabId)) {
    await appendPlaybackDebugLog(tabId, "advance-skipped-locked");
    return { success: false, locked: true };
  }
  catalogAdvanceLocks.set(tabId, true);
  try {
    const cached = await getCachedCatalog(tabId);
    if (!cached?.items?.length) {
      await appendPlaybackDebugLog(tabId, "advance-no-catalog");
      return { success: false };
    }

    const currentIndex = Number.isInteger(completedItem?.catalogIndex)
      ? completedItem.catalogIndex
      : cached.items.findIndex((item) => item.active);
    if (currentIndex < 0) {
      await appendPlaybackDebugLog(tabId, "advance-current-item-not-found", {
        completedItem,
        catalogSize: cached.items.length,
        activeItems: summarizeActiveCatalogItems(cached.items)
      });
      return { success: false };
    }

    const candidates = cached.items.slice(currentIndex + 1);
    const nextItem = candidates.find((item) =>
      skipWatched !== true || item.completed !== true
    );
    const selectedIndex = nextItem ? cached.items.indexOf(nextItem) : -1;
    const selectedOrder = selectedIndex >= 0 ? selectedIndex + 1 : null;
    await appendPlaybackDebugLog(tabId, "advance-decision", {
      skipWatched: skipWatched === true,
      completedItem,
      currentOrder: currentIndex + 1,
      catalogSize: cached.items.length,
      candidateCount: candidates.length,
      nearbyItems: summarizeCatalogWindow(cached.items, currentIndex, 3),
      selectedOrder,
      selectedItem: nextItem ? summarizeCatalog([nextItem], selectedOrder)[0] : null
    });
    if (!nextItem) return { success: false, done: true };

    const result = await playCatalogItem(tabId, nextItem);
    await appendPlaybackDebugLog(tabId, "advance-play-result", {
      requestedOrder: selectedOrder,
      requestedItem: summarizeCatalog([nextItem], selectedOrder)[0],
      result
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const finalActiveTitle = await getActiveCatalogTitle(tabId);
    const finalCatalog = await getCachedCatalog(tabId);
    const finalActiveIndex = finalCatalog?.items?.findIndex((item) => item.active) ?? -1;
    await appendPlaybackDebugLog(tabId, "advance-final-state", {
      requestedOrder: selectedOrder,
      requestedTitle: nextItem.title,
      pageActiveTitle: finalActiveTitle,
      cachedActiveOrder: finalActiveIndex >= 0 ? finalActiveIndex + 1 : null,
      cachedActiveTitle: finalActiveIndex >= 0 ? finalCatalog.items[finalActiveIndex].title : "",
      pageMatchesRequested: finalActiveTitle === nextItem.title
    });
    return result;
  } catch (error) {
    await appendPlaybackDebugLog(tabId, "advance-error", {
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    setTimeout(() => catalogAdvanceLocks.delete(tabId), 1200);
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
  const catalog = await getPageCatalog(tabId).catch(() => ({ items: [] }));
  const items = catalog.items || [];
  const activeItem = items.find((item) => item.active);
  const completedCount = items.filter((item) => item.completed).length + (activeItem && !activeItem.completed ? 1 : 0);
  const remainingCount = Math.max(0, items.length - completedCount);
  const completedItem = activeItem || (catalog.lastCompletedTitle ? { title: catalog.lastCompletedTitle } : items.find((item) => item.completed));
  const completedAt = new Date().toLocaleString("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium"
  });
  const title = tab.title || pageTitle || "当前网页";
  const pageUrl = tab.url || "";
  const catalogStats = items.length
    ? `\n完播课时：${completedItem?.title || "当前课时"}\n目录进度：${completedCount} / ${items.length} 已播放\n剩余视频：${remainingCount} 个`
    : "\n完播课时：当前视频\n目录统计：暂不可用";
  await requestQqMailDelivery({
    subject: "视频播放完成",
    text: `视频播放完成。${catalogStats}\n\n页面：${title}\n链接：${pageUrl}\n完成时间：${completedAt}`
  });
}

async function sendTestQqMail() {
  await requestQqMailDelivery({
    subject: "课程播放助手 - 测试邮件",
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

  if (message.type === "GET_PAGE_CATALOG") {
    return respond(getPageCatalog(message.tabId, message.forceRefresh === true), sendResponse);
  }

  if (message.type === "GET_PLAYBACK_DEBUG_LOG") {
    return respond(getPlaybackDebugLog(message.tabId), sendResponse);
  }

  if (message.type === "PLAY_CATALOG_ITEM") {
    return respond(playCatalogItem(message.tabId, message.item), sendResponse);
  }

  if (message.type === "SET_TRACKING") {
    const operation = message.enabled === true
      ? startMonitoringPlayback(message.tabId)
      : updateCurrentTabSettings(message.tabId, { enabled: false });
    return respond(
      operation,
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

  if (message.type === "SET_CATALOG_OPTIONS") {
    return respond(
      updateCurrentTabSettings(message.tabId, {
        continuousPlay: message.continuousPlay === true,
        skipWatched: message.skipWatched === true
      }),
      sendResponse
    );
  }

  if (message.type === "SAVE_REMINDER_SETTINGS") {
    return respond(
      saveReminderSettings({
        mode: message.mode,
        qqMail: message.qqMail
      }),
      sendResponse
    );
  }

  if (message.type === "SEND_TEST_QQ_MAIL") {
    return respond(sendTestQqMail(), sendResponse);
  }

  if (message.type === "VIDEO_ENDED" && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    (async () => {
      await appendPlaybackDebugLog(tabId, "video-ended-received", {
        pageTitle: message.pageTitle || "",
        senderFrameId: sender.frameId,
        senderUrl: sanitizeDebugUrl(sender.url || ""),
        video: message.video ? {
          ...message.video,
          currentSrc: sanitizeDebugUrl(message.video.currentSrc),
          frameUrl: sanitizeDebugUrl(message.video.frameUrl)
        } : null
      });
      // The popup cache may not have seen the latest active marker. Resolve it
      // from the page before composing mail statistics, then update the cache.
      const catalog = await getPageCatalog(tabId).catch(() => null);
      const activeTitle = await getActiveCatalogTitle(tabId);
      await appendPlaybackDebugLog(tabId, "completion-state-before-mark", {
        pageActiveTitle: activeTitle,
        lastCompletedTitle: catalog?.lastCompletedTitle || "",
        catalogCached: catalog?.cached === true,
        catalogSize: catalog?.items?.length || 0,
        activeItems: summarizeActiveCatalogItems(catalog?.items || []),
        nearbyItems: summarizeCatalogWindow(
          catalog?.items || [],
          (catalog?.items || []).findIndex((item) => item.active),
          3
        )
      });
      const completedItem = await markCachedCatalogActiveItemCompleted(tabId, activeTitle);
      await sendCompletionReminders(tabId, message.pageTitle);
      const settings = await getTabSettings(tabId);
      await appendPlaybackDebugLog(tabId, "completion-decision", {
        settings: {
          enabled: settings.enabled,
          continuousPlay: settings.continuousPlay,
          skipWatched: settings.skipWatched,
          playbackRate: settings.playbackRate
        },
        pageActiveTitle: activeTitle,
        completedItem
      });
      if (settings.enabled && settings.continuousPlay) {
        await advanceCatalogPlayback(tabId, settings.skipWatched, completedItem);
      }
    })().catch((error) => {
      // A delivery or catalog update failure must not disrupt page monitoring.
      appendPlaybackDebugLog(tabId, "completion-handler-error", {
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
    });
  }

});

function clearSettingsForTopFrame(details) {
  if (details.frameId === 0) {
    clearCachedCatalog(details.tabId).catch(() => {});
    clearTabSettings(details.tabId).catch(() => {});
  }
}

// Clear before a replacement document can inherit the previous page's controls.
chrome.webNavigation.onBeforeNavigate.addListener(clearSettingsForTopFrame);
chrome.webNavigation.onCommitted.addListener(clearSettingsForTopFrame);
chrome.webNavigation.onHistoryStateUpdated.addListener(clearSettingsForTopFrame);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearCachedCatalog(tabId).catch(() => {});
  clearTabSettings(tabId).catch(() => {});
  clearPlaybackDebugLog(tabId).catch(() => {});
});
