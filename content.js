(() => {
  const STATE_KEY = "__videoPlaybackCompletionReminderState__";
  const existingState = globalThis[STATE_KEY];

  if (existingState) {
    existingState.bootstrap();
    return;
  }

  const PAUSE_TIMEOUT_MS = 20_000;
  // Some course sites pause their video when the document becomes hidden.
  // When monitoring is enabled, immediately resume a video that was already
  // playing so switching tabs/minimizing the window does not stop playback.
  const BACKGROUND_RESUME_RETRY_MS = 150;
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

  function resumeInBackground(video, meta = videoMeta.get(video)) {
    if (!state.monitoringEnabled || !document.hidden || video.ended || meta?.completed || !video.paused) {
      return;
    }

    // play() can reject transiently while the site is changing its player
    // state; a short retry handles that case without creating a polling loop.
    Promise.resolve(video.play()).catch(() => {
      setTimeout(() => {
        if (state.monitoringEnabled && document.hidden && video.paused && !video.ended && !meta?.completed) {
          Promise.resolve(video.play()).catch(() => {});
        }
      }, BACKGROUND_RESUME_RETRY_MS);
    });
  }

  function handleVideoPlaying(meta) {
    meta.hasPlayed = true;
    // Only an explicit subsequent play starts a new playback cycle.
    meta.completed = false;
    meta.manuallyPaused = false;
    meta.alertFired = false;
    clearPauseTimer(meta);
  }

  function handleVideoPause(video, meta) {
    clearPauseTimer(meta);

    if (!document.hidden) {
      meta.manuallyPaused = true;
    }

    if (meta.completed) {
      return;
    }

    if (state.monitoringEnabled && document.hidden && !meta.manuallyPaused && meta.hasPlayed && !isNearEnd(video)) {
      resumeInBackground(video, meta);
      return;
    }

    if (meta.manuallyPaused) {
      return;
    }

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
    meta.completed = true;
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
      manuallyPaused: false,
      completed: video.ended,
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
    document.removeEventListener("visibilitychange", handleVisibilityChange, true);
  }

  function handleVisibilityChange() {
    if (!state.monitoringEnabled || !document.hidden) {
      return;
    }
    state.watchedVideos.forEach((video) => resumeInBackground(video));
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
    document.addEventListener("visibilitychange", handleVisibilityChange, true);
    handleVisibilityChange();
  }

  function applySettings(settings) {
    state.monitoringEnabled = settings?.enabled === true;
    state.playbackRate = Number(settings?.playbackRate) || 1;
    state.pauseReminderEnabled = settings?.pauseReminder !== false;
    if (document.documentElement) {
      document.documentElement.dataset.videoReminderEnabled = state.monitoringEnabled ? "1" : "0";
    }

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
