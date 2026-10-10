// A quiet, short major-third chime. Generated locally; no audio download,
// background playback, notification permission or microphone access.
(function (FCM) {
  'use strict';
  FCM.scheduleMentionChime = function (context) {
    try {
      for (const [frequency, delay, peak] of [[523.25, 0, .045], [659.25, .09, .032]]) {
        const start = context.currentTime + delay;
        const oscillator = context.createOscillator(), gain = context.createGain();
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(.0001, start);
        gain.gain.linearRampToValueAtTime(peak, start + .015);
        gain.gain.exponentialRampToValueAtTime(.0001, start + .15);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start); oscillator.stop(start + .17);
      }
      return true;
    } catch (error) { return false; }
  };

  FCM.createMentionSound = function ({ getWindow, getSettings, claim = async () => ({ play: false }) }) {
    let context = null, owner = null, document = null, destroyed = false, requesting = false;
    function closeContext() {
      const previous = context; context = null; owner = null;
      if (previous) { try { previous.close().catch(() => {}); } catch (error) { /* Audio failure cannot interrupt chat. */ } }
    }
    function detach() {
      if (document) {
        document.removeEventListener('pointerdown', interact, true);
        document.removeEventListener('keydown', interact, true);
        document = null;
      }
    }
    function refresh() {
      if (destroyed) return;
      const win = getWindow(), next = win?.document;
      if (owner && owner !== win) closeContext();
      if (next !== document) {
        detach(); document = next || null;
        document?.addEventListener('pointerdown', interact, true);
        document?.addEventListener('keydown', interact, true);
      }
      if (getSettings().mentionSound !== true) closeContext();
    }
    async function unlock(event, preview = false) {
      if (destroyed || !event?.isTrusted || (!preview && getSettings().mentionSound !== true)) return null;
      refresh();
      try {
        const win = getWindow();
        if (!context) {
          if (typeof win?.AudioContext !== 'function') return null;
          context = new win.AudioContext(); owner = win;
        }
        const current = context;
        if (current.state === 'suspended') await current.resume();
        return !destroyed && context === current && current.state === 'running' ? current : null;
      } catch (error) { return null; }
    }
    function interact(event) { return unlock(event); }
    refresh();
    return {
      refresh, arm: interact,
      async preview(event) { const current = await unlock(event, true); return current ? FCM.scheduleMentionChime(current) : false; },
      async notify(message, row) {
        const eligible = () => !destroyed && getSettings().mentionSound === true && !message.history
          && row?.classList.contains('fcm-mentioned') && !row.classList.contains('fcm-hide') && !row.classList.contains('fcm-deleted');
        if (!eligible() || requesting) return false;
        refresh();
        const current = context;
        // Do not resume or queue alerts automatically. Browser autoplay rules
        // require a trusted interaction after a reload or moving to a pop-out.
        if (!current || current.state !== 'running') return false;
        requesting = true;
        try {
          const result = await claim();
          return result?.play === true && eligible() && context === current && owner === getWindow()
            && current.state === 'running' ? FCM.scheduleMentionChime(current) : false;
        } catch (error) { return false; }
        finally { requesting = false; }
      },
      destroy() { destroyed = true; detach(); closeContext(); },
    };
  };
})(self.FCM);
