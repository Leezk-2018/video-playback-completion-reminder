(() => {
  const HOOK_KEY = "__videoReminderPauseHookInstalled__";
  if (globalThis[HOOK_KEY]) return;
  globalThis[HOOK_KEY] = true;

  // 顶层页面已由 manifest 的 content_scripts.matches 限定为
  // https://basic.smartedu.cn/teacherTraining*。此处的自检用于覆盖
  // all_frames 注入进来的播放器 iframe —— 它们可能位于 smartedu.cn 的其它子域。
  const isSmartEdu = /(^|\.)smartedu\.cn$/i.test(location.hostname);
  if (!isSmartEdu) return;

  const originalPause = HTMLMediaElement.prototype.pause;
  const originalPlay = HTMLMediaElement.prototype.play;
  const completedVideos = new WeakSet();

  document.addEventListener("ended", (event) => {
    if (event.target instanceof HTMLVideoElement) {
      completedVideos.add(event.target);
    }
  }, true);

  HTMLMediaElement.prototype.play = function (...args) {
    completedVideos.delete(this);
    return originalPlay.apply(this, args);
  };

  HTMLMediaElement.prototype.pause = function (...args) {
    const enabled = document.documentElement?.dataset.videoReminderEnabled === "1";
    const shouldKeepPlaying = enabled && document.hidden && this instanceof HTMLVideoElement &&
      !completedVideos.has(this) &&
      !this.ended && !(this.duration > 0 && this.currentTime >= this.duration - 1.5);

    if (shouldKeepPlaying) {
      return;
    }

    return originalPause.apply(this, args);
  };

})();
