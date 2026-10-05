// Chat capture lasts for one visit. An explicit saved channel link opts
// that host into fresh live-stream lookup on later visits as well.
(function (FCM) {
  'use strict';

  FCM.attachYouTubeControls = function ({ site, channel, container, feed, filter, onFilterChange, onSendState, onSuggestionsChange }) {
    const doc = container.ownerDocument;
    container.className = 'fcm-youtube-wrap';
    const suggestionBox = doc.createElement('div');
    suggestionBox.className = 'fcm-youtube-suggestions';
    suggestionBox.hidden = true;
    container.appendChild(suggestionBox);
    const visibility = doc.createElement('button');
    visibility.type = 'button'; visibility.className = 'fcm-chip-btn';
    visibility.dataset.platform = 'youtube'; visibility.dataset.on = 'false';
    visibility.textContent = 'YouTube'; visibility.disabled = true;
    visibility.setAttribute('aria-label', 'Show or hide YouTube messages');
    visibility.setAttribute('aria-pressed', 'false');
    visibility.addEventListener('click', () => {
      if (visibility.disabled) return;
      if (filter.has('youtube')) filter.delete('youtube'); else filter.add('youtube');
      if (!filter.size) filter.add('youtube');
      visibility.dataset.on = String(filter.has('youtube'));
      visibility.setAttribute('aria-pressed', visibility.dataset.on);
      feed.applyFilter(filter); onFilterChange();
    });
    container.appendChild(visibility);
    const section = doc.createElement('details');
    section.className = 'fcm-youtube';
    const summary = doc.createElement('summary');
    summary.textContent = 'YouTube';
    const form = doc.createElement('form');
    const label = doc.createElement('label');
    label.textContent = 'YouTube live video or channel URL';
    const input = doc.createElement('input');
    input.type = 'text';
    input.placeholder = 'https://www.youtube.com/@channel or watch?v=\u2026';
    input.setAttribute('aria-label', 'YouTube live video or channel URL');
    input.maxLength = 2048;
    input.autocomplete = 'off';
    label.appendChild(input);
    const add = doc.createElement('button');
    add.type = 'button';
    add.textContent = 'Add chat';
    const stop = doc.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Remove YouTube';
    stop.disabled = true;
    const check = doc.createElement('button');
    check.type = 'button';
    check.textContent = 'Check YouTube';
    const access = doc.createElement('a');
    access.href = chrome.runtime.getURL('src/youtube/permission.html');
    access.target = '_blank';
    access.rel = 'noopener noreferrer';
    access.textContent = 'Allow YouTube access';
    const nativeChat = doc.createElement('a');
    nativeChat.textContent = 'Open YouTube chat'; nativeChat.target = '_blank';
    nativeChat.rel = 'noopener noreferrer'; nativeChat.hidden = true;
    nativeChat.title = 'Open this stream’s native YouTube chat for moderation, polls, emotes and other YouTube controls';
    const status = doc.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Off. Add a live video or channel URL to merge YouTube messages on this channel.';
    const save = doc.createElement('button');
    save.type = 'button';
    save.textContent = 'Save YouTube link';
    const forget = doc.createElement('button');
    forget.type = 'button';
    forget.textContent = 'Forget YouTube link';
    const pairLabel = doc.createElement('label');
    pairLabel.className = 'fcm-youtube-pair';
    pairLabel.hidden = true;
    const pairCheck = doc.createElement('input');
    pairCheck.type = 'checkbox';
    const pairText = doc.createElement('span');
    pairLabel.append(pairCheck, pairText);
    const linkNote = doc.createElement('p');
    linkNote.className = 'fcm-youtube-link-note';
    form.append(label, add, stop, check, access, nativeChat, status, pairLabel, save, forget, linkNote);
    section.append(summary, form);
    container.appendChild(section);

    let destroyed = false;
    let active = false;
    let epoch = 0;
    let suggestionVersion = 0;
    let saved = null, counterpart = null, linksPending = true, linkBusy = false, linkLoad = 0;
    function current() {
      try { return !destroyed && site.channelFromUrl() === channel; }
      catch (_) { return false; }
    }
    function linkButtons() {
      save.disabled = linksPending || linkBusy;
      forget.disabled = linksPending || linkBusy || !saved;
      pairCheck.disabled = linksPending || linkBusy;
    }
    function describeLink() {
      linkNote.textContent = saved
        ? `Saved for ${site.id}/${channel}: ${saved.channelUrl}. Live chat loads on each visit. Remove stops this visit; Forget removes this page's saved link.`
        : `Save a channel URL to load its live chat automatically on ${site.id}/${channel}. Video URLs work for this visit only.`;
      linkButtons();
    }
    async function request(cmd, data = {}) {
      try { return await chrome.runtime.sendMessage({ cmd, platform: site.id, channel, ...data }); }
      catch (_) { return null; }
    }
    function clearSuggestions() {
      suggestionVersion++;
      suggestionBox.replaceChildren();
      suggestionBox.hidden = true;
      if (onSuggestionsChange) onSuggestionsChange(0);
    }
    const suggestions = FCM.createYouTubeSuggestions ? FCM.createYouTubeSuggestions({
      site, channel, document: doc,
      onSuggestions(items) {
        if (!current() || active || linksPending || saved) return;
        clearSuggestions();
        const version = suggestionVersion;
        items.forEach(item => {
          const row = doc.createElement('div');
          const note = doc.createElement('p');
          note.textContent = item.match === 'page-link'
            ? 'Live on YouTube · Linked on this page'
            : 'Live on YouTube · Possible same-name match';
          const link = doc.createElement('a');
          link.textContent = item.label;
          link.href = item.channelUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          const accept = doc.createElement('button');
          accept.type = 'button';
          accept.textContent = 'Add YouTube chat';
          accept.addEventListener('click', event => {
            if (version !== suggestionVersion) return;
            return start(event, item.channelUrl);
          });
          row.append(note, link, accept);
          suggestionBox.appendChild(row);
        });
        if (items.length) {
          const dismiss = doc.createElement('button');
          dismiss.type = 'button';
          dismiss.textContent = 'Dismiss';
          dismiss.addEventListener('click', event => {
            if (!event.isTrusted || destroyed || version !== suggestionVersion) return;
            suggestions.pause();
            clearSuggestions();
          });
          suggestionBox.appendChild(dismiss);
          suggestionBox.hidden = false;
          if (onSuggestionsChange) onSuggestionsChange(items.length);
        }
      },
    }) : null;
    const source = FCM.createYouTubeSource({
      onSendState(state) {
        if (current() && onSendState) onSendState(state);
      },
      onStatus(update) {
        if (!current()) return;
        status.textContent = update.text;
      },
      onBatch(batch) {
        if (!current() || !active) return;
        if (visibility.disabled) {
          visibility.disabled = false; filter.add('youtube'); visibility.dataset.on = 'true';
          visibility.setAttribute('aria-pressed', 'true');
        }
        try {
          const video = FCM.youtube.videoId(batch.videoId);
          nativeChat.href = `https://www.youtube.com/live_chat?v=${video}&is_popout=1`; nativeChat.hidden = false;
        } catch (_) { /* Only a validated current video can open native chat. */ }
        batch.messages.forEach((message) => {
          if (FCM.view.settings.showEvents === false && ['membership', 'gift', 'gift-received'].includes(message.youtubeEvent?.kind)) return;
          feed.addMessage({
          platform: 'youtube', messageId: message.id,
          author: message.displayName, login: message.username,
          text: message.text, timestamp: message.ts, readOnly: true, youtubeEmotes: message.youtubeEmotes,
          youtubeEvent: message.youtubeEvent, youtubeBadges: message.youtubeBadges,
        }, filter); });
        batch.deleted.forEach((id) => feed.markMessageDeleted('youtube', id));
      },
    });

    function drop() {
      nativeChat.hidden = true; nativeChat.removeAttribute('href'); visibility.disabled = true;
      visibility.dataset.on = 'false'; visibility.setAttribute('aria-pressed', 'false');
      filter.delete('youtube');
      feed.dropPlatform('youtube');
      FCM.forgetChatters('youtube');
      if (!filter.size) {
        FCM.PLATFORMS.forEach(platform => filter.add(platform));
        feed.applyFilter(filter);
        onFilterChange();
      }
    }

    async function start(event, value = input.value) {
      event.preventDefault();
      // The host can inspect our open shadow root. Only a genuine click/key
      // may attach a source; requestSubmit() alone is not user authorization.
      if (!event.isTrusted || !current() || add.disabled) return;
      return begin(value);
    }

    async function begin(value, reveal = true) {
      const mine = ++epoch;
      if (suggestions) suggestions.pause();
      clearSuggestions();
      if (reveal) section.open = true;
      add.disabled = true;
      check.disabled = true;
      stop.disabled = false;
      active = true;
      drop();
      try {
        const accepted = await source.start(value);
        if (!current() || mine !== epoch) return;
        active = accepted;
        stop.disabled = !accepted;
      } catch (error) {
        if (!current() || mine !== epoch) return;
        active = false;
        stop.disabled = true;
        status.textContent = 'YouTube could not start. Try Add chat again.';
      } finally {
        if (current() && mine === epoch) {
          add.disabled = false;
          check.disabled = active;
        }
      }
    }

    function remove() {
      ++epoch;
      if (suggestions) suggestions.pause();
      clearSuggestions();
      check.disabled = false;
      active = false;
      add.disabled = false;
      stop.disabled = true;
      source.stop();
      drop();
    }

    function refresh(event) {
      if (!event.isTrusted || !current() || active || add.disabled) return;
      if (saved) return begin(saved.channelUrl);
      clearSuggestions();
      if (suggestions) suggestions.refresh();
    }

    async function loadLink(autoStart) {
      const mine = epoch, reading = ++linkLoad;
      linksPending = true;
      linkButtons();
      if (suggestions) suggestions.pause();
      const result = await request('youtubeLinkGet');
      if (!current() || reading !== linkLoad) return;
      linksPending = false;
      if (!result || !result.ok) {
        linkButtons();
        linkNote.textContent = 'Could not read the saved YouTube link. Reopen these controls to retry.';
        return;
      }
      saved = result.link;
      counterpart = result.counterpart;
      pairLabel.hidden = !counterpart;
      pairCheck.checked = false;
      if (counterpart) {
        pairText.textContent = `Also link ${counterpart.platform}/${counterpart.channel}`
          + (counterpart.link ? ` (replace ${counterpart.link.channelUrl})` : '');
      }
      describeLink();
      if (mine !== epoch) return;
      if (saved) {
        if (!input.value) input.value = saved.channelUrl;
        if (autoStart) await begin(saved.channelUrl, false);
      } else if (autoStart && suggestions) suggestions.refresh();
    }

    async function saveLink(event) {
      if (!event.isTrusted || !current() || save.disabled || add.disabled) return;
      let channelUrl;
      try { channelUrl = FCM.youtube.parseInput(input.value).channelUrl; }
      catch (_) { /* Show the same helpful message for malformed and video URLs. */ }
      if (!channelUrl) {
        linkNote.textContent = 'Use a YouTube channel URL to save a link. A video URL can be added for this visit.';
        return;
      }
      const mine = ++epoch;
      linkBusy = true;
      linkButtons();
      const result = await request('youtubeLinkSave', { channelUrl,
        ...(pairCheck.checked && counterpart ? { counterpartChannel: counterpart.channel } : {}) });
      if (!current()) return;
      linkBusy = false;
      if (!result || !result.ok) {
        linkButtons();
        linkNote.textContent = 'YouTube link was not saved. Reopen these controls and try again.';
        return;
      }
      saved = result.link;
      pairCheck.checked = false;
      describeLink();
      if (mine === epoch) {
        input.value = saved.channelUrl;
        await begin(saved.channelUrl);
      }
    }

    async function forgetLink(event) {
      if (!event.isTrusted || !current() || forget.disabled) return;
      remove();
      linkBusy = true;
      linkButtons();
      const result = await request('youtubeLinkForget');
      if (!current()) return;
      linkBusy = false;
      if (result && result.ok) {
        saved = null;
        describeLink();
      } else {
        linkButtons();
        linkNote.textContent = 'The saved YouTube link could not be removed. Try Forget again.';
      }
    }

    function preventSubmit(event) { event.preventDefault(); }
    function onKey(event) { if (event.key === 'Enter') void start(event); }
    form.addEventListener('submit', preventSubmit);
    add.addEventListener('click', start);
    input.addEventListener('keydown', onKey);
    stop.addEventListener('click', remove);
    check.addEventListener('click', refresh);
    save.addEventListener('click', saveLink);
    forget.addEventListener('click', forgetLink);
    describeLink();
    void loadLink(true);
    return {
      getSendState() { return source.getSendState(); },
      openAccessSetup() { return current() && source.openAccessSetup(); },
      closeAccessSetup() { if (current()) source.closeAccessSetup(); },
      send(text) {
        return current() ? source.send(text) : Promise.resolve({ sequence: 0, outcome: 'not-sent', reason: 'not-current' });
      },
      updateCounterpart(info) { if (!destroyed && suggestions) suggestions.updateCounterpart(info); },
      openLinks() {
        if (!current()) return;
        section.open = true;
        input.focus();
        if (!linkBusy) void loadLink(false);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        active = false;
        ++epoch;
        source.destroy();
        FCM.forgetChatters('youtube');
        if (suggestions) suggestions.destroy();
        clearSuggestions();
        suggestionBox.remove();
        filter.delete('youtube');
        form.removeEventListener('submit', preventSubmit);
        add.removeEventListener('click', start);
        input.removeEventListener('keydown', onKey);
        stop.removeEventListener('click', remove);
        check.removeEventListener('click', refresh);
        save.removeEventListener('click', saveLink);
        forget.removeEventListener('click', forgetLink);
        section.remove();
      },
    };
  };
})(self.FCM);
