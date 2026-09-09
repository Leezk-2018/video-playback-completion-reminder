(() => {
  const STATE_KEY = "__videoPlaybackCompletionReminderState__";
  const existingState = globalThis[STATE_KEY];

  if (existingState) {
    existingState.bootstrap();
    return;
  }

  // Keep monitored videos running while monitoring is enabled. A short retry
  // loop covers players that reject play() while their state is changing.
  const PLAYBACK_RESUME_RETRY_MS = 500;
  const videoMeta = new WeakMap();

  const state = {
    bootstrapSequence: 0,
    monitoringEnabled: false,
    observer: null,
    playbackRate: 1,
    continuousPlay: false,
    skipWatched: false,
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

  function isNearEnd(video) {
    return video.ended || (video.duration > 0 && video.currentTime >= video.duration - 1.5);
  }

  function clearResumeRetry(meta) {
    if (meta?.resumeRetryTimer) {
      clearTimeout(meta.resumeRetryTimer);
      meta.resumeRetryTimer = null;
    }
  }

  function resumePlayback(video, meta = videoMeta.get(video)) {
    if (!state.monitoringEnabled || video.ended || meta?.completed || !video.paused || isNearEnd(video)) {
      return;
    }

    Promise.resolve(video.play()).catch(() => {
      clearResumeRetry(meta);
      meta.resumeRetryTimer = setTimeout(() => {
        meta.resumeRetryTimer = null;
        resumePlayback(video, meta);
      }, PLAYBACK_RESUME_RETRY_MS);
    });
  }

  function handleVideoPlaying(meta) {
    // A subsequent play starts a new playback cycle after a completed video.
    meta.completed = false;
    clearResumeRetry(meta);
  }

  function handleVideoPause(video, meta) {
    if (meta.completed) {
      return;
    }

    resumePlayback(video, meta);
  }

  function handleVideoEnded(meta) {
    meta.completed = true;
    clearResumeRetry(meta);
    reportCompletion();
  }

  function handleVideoTimeUpdate(video, meta) {
    if (isNearEnd(video)) {
      clearResumeRetry(meta);
    }
  }

  function watchVideo(video) {
    if (state.watchedVideos.has(video)) {
      applyPlaybackRate(video);
      return;
    }

    const meta = {
      resumeRetryTimer: null,
      completed: video.ended,
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
      clearResumeRetry(meta);
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
        clearResumeRetry(meta);
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
    state.watchedVideos.forEach((video) => resumePlayback(video));
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
    state.watchedVideos.forEach((video) => resumePlayback(video));
  }

  function applySettings(settings) {
    state.monitoringEnabled = settings?.enabled === true;
    state.playbackRate = Number(settings?.playbackRate) || 1;
    state.continuousPlay = settings?.continuousPlay === true;
    state.skipWatched = settings?.skipWatched === true;
    if (document.documentElement) {
      document.documentElement.dataset.videoReminderEnabled = state.monitoringEnabled ? "1" : "0";
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
      applySettings({ enabled: false, playbackRate: 1 });
    }
  }

  bootstrap();
})();
