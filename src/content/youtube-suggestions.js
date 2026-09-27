// Page-scoped metadata suggestions. Only the separate Add action opens chat.
(function (FCM) {
  'use strict';

  FCM.createYouTubeSuggestions = function ({ site, channel, document: doc, onSuggestions }) {
    let destroyed = false, paused = false, scanned = false, pending = false;
    let generation = 0, counterpart = null, candidates = [], timers = [];
    const results = new Map(), attempted = new Set();

    function current() {
      try {
        return ['twitch', 'kick'].includes(site.id) && typeof channel === 'string'
          && channel.length > 0 && site.channelFromUrl() === channel;
      } catch (_) { return false; }
    }

    function candidate(input, match) {
      try {
        const channelUrl = FCM.youtube.parseInput(input).channelUrl;
        if (!channelUrl) return null;
        const path = new URL(channelUrl).pathname;
        return { channelUrl, match, label: decodeURIComponent(path.slice(1)),
          key: path.startsWith('/channel/') ? channelUrl : channelUrl.toLowerCase() };
      } catch (_) { return null; }
    }

    function publish() {
      const visible = current() ? candidates : [];
      onSuggestions(visible.filter(item => results.has(item.key)).map(item => ({
        channelUrl: item.channelUrl, videoId: results.get(item.key), match: item.match, label: item.label,
      })));
    }

    async function pump() {
      if (pending || destroyed || paused || !current()) return;
      pending = true;
      const mine = generation;
      try {
        while (!destroyed && !paused && mine === generation && current()) {
          const next = candidates.find(item => !attempted.has(item.key));
          if (!next || attempted.size >= 6) break;
          attempted.add(next.key);
          let answer;
          try { answer = await chrome.runtime.sendMessage({ cmd: 'youtubeSuggest', channelUrl: next.channelUrl }); }
          catch (_) { answer = null; }
          if (destroyed || paused || mine !== generation || !current()) break;
          if (answer && typeof answer.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(answer.videoId)) {
            results.set(next.key, answer.videoId);
          }
          publish();
        }
      } finally {
        pending = false;
        // A refresh during an old request waits for it to finish, then starts
        // the new visit budget without publishing that request's late result.
        if (mine !== generation) void pump();
      }
    }

    function scan() {
      if (destroyed || paused) return;
      scanned = true;
      candidates = [];
      if (current()) {
        let hints = [];
        try { hints = site.youtubeHints(doc); } catch (_) { /* Page not ready. */ }
        const add = item => {
          if (item && !candidates.some(existing => existing.key === item.key)) candidates.push(item);
        };
        if (Array.isArray(hints)) {
          for (const href of hints.slice(0, 40)) {
            add(candidate(href, 'page-link'));
            if (candidates.length === 3) break;
          }
        }
        if (!candidates.length) {
          const names = [channel];
          if (counterpart && counterpart.exists) names.push(counterpart.channel);
          names.forEach(name => {
            if (typeof name === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(name)) {
              add(candidate('https://www.youtube.com/@' + name, 'same-name'));
            }
          });
        }
      }
      publish();
      void pump();
    }

    function clearTimers() {
      timers.forEach(timer => clearTimeout(timer));
      timers = [];
    }

    function schedule() {
      timers = [1500, 4000, 9000].map(delay => setTimeout(scan, delay));
    }

    function pause() {
      paused = true;
      ++generation;
      clearTimers();
      candidates = [];
      if (!destroyed) onSuggestions([]);
    }

    schedule();
    return {
      updateCounterpart(info) {
        counterpart = info;
        if (scanned) scan();
      },
      pause,
      refresh() {
        if (destroyed) return;
        ++generation;
        paused = false;
        clearTimers();
        results.clear();
        attempted.clear();
        scan();
        schedule();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        pause();
      },
    };
  };
})(self.FCM);
