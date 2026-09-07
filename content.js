(() => {
  const STATE_KEY = "__videoPlaybackCompletionReminderState__";
  const existingState = globalThis[STATE_KEY];

  if (existingState) {
    existingState.bootstrap();
    return;
  }

  const state = {
    bootstrapSequence: 0,
    monitoringEnabled: false,
    observer: null,
    playbackRate: 1,
    watchedVideos: new Set(),
    bootstrap
  };

  globalThis[STATE_KEY] = state;

  function reportCompletion() {
    if (!state.monitoringEnabled) {
      return;
    }

    chrome.runtime.sendMessage({
      type: "VIDEO_ENDED",
      pageTitle: document.title
    }).catch(() => {
      // The background worker can be unavailable briefly during page teardown.
    });
  }

  function applyPlaybackRate(video) {
    try {
      video.defaultPlaybackRate = state.playbackRate;
      video.playbackRate = state.playbackRate;
    } catch {
      // Some media implementations can reject rate changes until metadata loads.
    }
  }

  function watchVideo(video) {
    if (state.watchedVideos.has(video)) {
      applyPlaybackRate(video);
      return;
    }

    video.addEventListener("ended", reportCompletion);
    state.watchedVideos.add(video);
    applyPlaybackRate(video);
  }

  function unwatchVideo(video) {
    if (!state.watchedVideos.delete(video)) {
      return;
    }

    video.removeEventListener("ended", reportCompletion);
  }

  function watchVideoTree(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node;
    if (element.matches("video")) {
      watchVideo(element);
    }
    element.querySelectorAll("video").forEach(watchVideo);
  }

  function unwatchVideoTree(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node;
    if (element.matches("video")) {
      unwatchVideo(element);
    }
    element.querySelectorAll("video").forEach(unwatchVideo);
  }

  function stopObserving() {
    state.observer?.disconnect();
    state.observer = null;
    for (const video of state.watchedVideos) {
      video.removeEventListener("ended", reportCompletion);
    }
    state.watchedVideos.clear();
  }

  function startObserving() {
    if (state.observer) {
      return;
    }

    document.querySelectorAll("video").forEach(watchVideo);
    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach(unwatchVideoTree);
        record.addedNodes.forEach(watchVideoTree);
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function applySettings(settings) {
    state.monitoringEnabled = settings?.enabled === true;
    state.playbackRate = Number(settings?.playbackRate) || 1;

    if (state.monitoringEnabled || state.playbackRate !== 1) {
      startObserving();
      state.watchedVideos.forEach(applyPlaybackRate);
      return;
    }

    stopObserving();
  }

  async function bootstrap() {
    const sequence = ++state.bootstrapSequence;

    try {
      const settings = await chrome.runtime.sendMessage({
        type: "GET_TAB_SETTINGS"
      });

      if (sequence === state.bootstrapSequence) {
        applySettings(settings);
      }
    } catch {
      applySettings({ enabled: false, playbackRate: 1 });
    }
  }

  bootstrap();
})();
