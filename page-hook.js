(() => {
  const HOOK_KEY = "__videoReminderPauseHookInstalled__";
  if (globalThis[HOOK_KEY]) return;
  globalThis[HOOK_KEY] = true;

  const isSmartEdu = /(^|\.)smartedu\.cn$/i.test(location.hostname);
  if (!isSmartEdu) return;

  const originalPause = HTMLMediaElement.prototype.pause;
  const originalPlay = HTMLMediaElement.prototype.play;
  const manuallyPaused = new WeakSet();
  const completedVideos = new WeakSet();

  document.addEventListener("ended", (event) => {
    if (event.target instanceof HTMLVideoElement) {
      completedVideos.add(event.target);
    }
  }, true);

  HTMLMediaElement.prototype.play = function (...args) {
    manuallyPaused.delete(this);
    completedVideos.delete(this);
    return originalPlay.apply(this, args);
  };

  HTMLMediaElement.prototype.pause = function (...args) {
    const enabled = document.documentElement?.dataset.videoReminderEnabled === "1";
    if (!document.hidden) {
      manuallyPaused.add(this);
    }
    const shouldKeepPlaying = enabled && document.hidden && this instanceof HTMLVideoElement &&
      !completedVideos.has(this) &&
      !manuallyPaused.has(this) &&
      !this.ended && !(this.duration > 0 && this.currentTime >= this.duration - 1.5);

    if (shouldKeepPlaying) {
      return;
    }

    return originalPause.apply(this, args);
  };

})();
