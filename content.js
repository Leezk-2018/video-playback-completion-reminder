(() => {
  const STATE_KEY = "__videoPlaybackCompletionReminderState__";
  const existingState = globalThis[STATE_KEY];

  if (existingState) {
    existingState.bootstrap();
    return;
  }

  const PAUSE_TIMEOUT_MS = 20_000;
  const videoMeta = new WeakMap();

  const state = {
    bootstrapSequence: 0,
    monitoringEnabled: false,
    pauseReminderEnabled: true,
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

  function reportPause(video) {
    if (!state.monitoringEnabled || !state.pauseReminderEnabled) {
      return;
    }

    chrome.runtime.sendMessage({
      type: "VIDEO_PAUSED",
      pageTitle: document.title,
      currentTime: Math.floor(video.currentTime || 0),
      duration: Math.floor(video.duration || 0)
    }).catch(() => {});
  }

  function applyPlaybackRate(video) {
    try {
      video.defaultPlaybackRate = state.playbackRate;
      video.playbackRate = state.playbackRate;
    } catch {
      // Some media implementations can reject rate changes until metadata loads.
    }
  }

  function isNearEnd(video) {
    return video.ended || (video.duration > 0 && video.currentTime >= video.duration - 1.5);
  }

  function clearPauseTimer(meta) {
    if (meta?.pauseTimer) {
      clearTimeout(meta.pauseTimer);
      meta.pauseTimer = null;
    }
  }

  function handleVideoPlaying(meta) {
    meta.hasPlayed = true;
    meta.alertFired = false;
    clearPauseTimer(meta);
  }

  function handleVideoPause(video, meta) {
    clearPauseTimer(meta);

    if (!state.monitoringEnabled || !state.pauseReminderEnabled) {
      return;
    }

    // Only alert for videos that were actively played on this page
    if (!meta.hasPlayed) {
      return;
    }

    // Ignore if ended or near end
    if (isNearEnd(video)) {
      return;
    }

    // Ignore tiny or short clips (ads / preview < 10 seconds)
    if (video.duration > 0 && video.duration < 10) {
      return;
    }

    if (meta.alertFired) {
      return;
    }

    meta.pauseTimer = setTimeout(() => {
      meta.pauseTimer = null;
      if (!state.monitoringEnabled || !state.pauseReminderEnabled) {
        return;
      }
      if (!video.paused || isNearEnd(video) || meta.alertFired) {
        return;
      }
      meta.alertFired = true;
      reportPause(video);
    }, PAUSE_TIMEOUT_MS);
  }

  function handleVideoEnded(meta) {
    meta.hasPlayed = false;
    meta.alertFired = true;
    clearPauseTimer(meta);
    reportCompletion();
  }

  function handleVideoTimeUpdate(video, meta) {
    if (!video.paused && video.currentTime > 0) {
      meta.hasPlayed = true;
    }
    if (isNearEnd(video)) {
      clearPauseTimer(meta);
    }
  }

  function watchVideo(video) {
    if (state.watchedVideos.has(video)) {
      applyPlaybackRate(video);
      return;
    }

    const meta = {
      pauseTimer: null,
      hasPlayed: !video.paused && video.currentTime > 0,
      alertFired: false,
      onEnded: () => handleVideoEnded(meta),
      onPlaying: () => handleVideoPlaying(meta),
      onPause: () => handleVideoPause(video, meta),
      onTimeUpdate: () => handleVideoTimeUpdate(video, meta)
    };

    videoMeta.set(video, meta);

    video.addEventListener("ended", meta.onEnded);
    video.addEventListener("playing", meta.onPlaying);
    video.addEventListener("play", meta.onPlaying);
    video.addEventListener("pause", meta.onPause);
    video.addEventListener("timeupdate", meta.onTimeUpdate);

    state.watchedVideos.add(video);
    applyPlaybackRate(video);
  }

  function unwatchVideo(video) {
    if (!state.watchedVideos.delete(video)) {
      return;
    }

    const meta = videoMeta.get(video);
    if (meta) {
      clearPauseTimer(meta);
      video.removeEventListener("ended", meta.onEnded);
      video.removeEventListener("playing", meta.onPlaying);
      video.removeEventListener("play", meta.onPlaying);
      video.removeEventListener("pause", meta.onPause);
      video.removeEventListener("timeupdate", meta.onTimeUpdate);
      videoMeta.delete(video);
    }
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
      const meta = videoMeta.get(video);
      if (meta) {
        clearPauseTimer(meta);
        video.removeEventListener("ended", meta.onEnded);
        video.removeEventListener("playing", meta.onPlaying);
        video.removeEventListener("play", meta.onPlaying);
        video.removeEventListener("pause", meta.onPause);
        video.removeEventListener("timeupdate", meta.onTimeUpdate);
        videoMeta.delete(video);
      }
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
    state.pauseReminderEnabled = settings?.pauseReminder !== false;

    if (!state.pauseReminderEnabled) {
      for (const video of state.watchedVideos) {
        clearPauseTimer(videoMeta.get(video));
      }
    }

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
      applySettings({ enabled: false, playbackRate: 1, pauseReminder: false });
    }
  }

  bootstrap();
})();
