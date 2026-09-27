// Uses only the native composer in this reader's marked YouTube frame.
// A submitted result confirms native draft clearing, never server delivery.
(function (FCM) {
  'use strict';
  FCM.createYouTubeSender = function ({ document, onState, onResult, isCurrent }) {
    let destroyed = false, pending = null, lastSequence = 0, capability = 0, identity = null, lastState = '';

    function current() {
      try { return !destroyed && isCurrent(); } catch (_) { return false; }
    }

    function hidden(node, allowAuthorChip = false) {
      for (let item = node; item; item = item.parentElement) {
        // YouTube hides this identity chip while its empty composer is idle.
        // Its bound account label still identifies the session used to send.
        if (allowAuthorChip && item.tagName === 'YT-LIVE-CHAT-AUTHOR-CHIP') continue;
        if (item.hasAttribute('hidden') || item.getAttribute('aria-hidden') === 'true') return true;
        const style = document.defaultView.getComputedStyle(item);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
      }
      return false;
    }

    function inspect() {
      const value = { root: null, input: null, button: null, accountLabel: '', reason: 'composer-unavailable' };
      try {
        value.root = document.querySelector('yt-live-chat-message-input-renderer');
        if (!value.root || !value.root.isConnected) return value;
        if (hidden(value.root)) { value.reason = 'restricted'; return value; }
        const author = value.root.querySelector('#author-name');
        if (author && !hidden(author, true)) value.accountLabel = author.textContent.replace(/\s+/g, ' ').trim();
        if (!value.accountLabel || value.accountLabel.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(value.accountLabel)) {
          value.accountLabel = '';
          value.reason = 'signed-out';
          return value;
        }
        value.input = value.root.querySelector('yt-live-chat-text-input-field-renderer div#input[contenteditable]');
        value.button = value.root.querySelector('#send-button button');
        if (!value.input || !value.button || !value.input.isConnected || !value.button.isConnected) return value;
        value.reason = hidden(value.input)
          || value.input.getAttribute('contenteditable') === 'false'
          || value.input.hasAttribute('disabled') || value.input.hasAttribute('readonly')
          || value.input.getAttribute('aria-disabled') === 'true'
          || value.root.hasAttribute('disabled') || value.root.getAttribute('aria-disabled') === 'true'
          ? 'restricted' : 'ready';
      } catch (_) { value.reason = 'composer-unavailable'; }
      return value;
    }

    function same(a, b) {
      return !!b && a.root === b.root && a.input === b.input && a.button === b.button && a.accountLabel === b.accountLabel;
    }

    function state(view) {
      if (!same(view, identity)) { capability++; identity = view; }
      const reason = pending ? 'busy' : current() ? view.reason : 'composer-unavailable';
      const result = { available: reason === 'ready', reason, accountLabel: view.accountLabel, capability, maxLength: 200 };
      const key = JSON.stringify(result);
      if (key !== lastState) { lastState = key; onState(result); }
    }

    function inputEvent(input, text) {
      input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true,
        inputType: text ? 'insertText' : 'deleteContentBackward', data: text }));
    }

    function cleanup(attempt) {
      try {
        if (same(inspect(), attempt.view) && attempt.view.input.textContent === attempt.text) {
          attempt.view.input.textContent = '';
          inputEvent(attempt.view.input, '');
        }
      } catch (_) { /* Never overwrite a changed draft or retry failed cleanup. */ }
    }

    function finish(attempt, outcome, reason) {
      if (pending !== attempt) return;
      clearTimeout(attempt.timer);
      pending = null;
      if (!attempt.clicked) cleanup(attempt);
      onResult({ sequence: attempt.sequence, outcome, reason });
      refresh();
    }

    function errorPresent(view) {
      const error = view.root.querySelector('#error-message');
      return !!(error && !hidden(error) && error.textContent.trim());
    }

    function enabled(button) {
      return !button.disabled && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true';
    }

    function step(attempt) {
      if (pending !== attempt) return;
      const fail = reason => finish(attempt, attempt.clicked ? 'uncertain' : 'not-sent', reason);
      try {
        if (!current()) { fail('not-current'); return; }
        const view = inspect();
        state(view);
        if (pending !== attempt) return;
        if (!same(view, attempt.view)) { fail('stale-capability'); return; }
        if (view.reason !== 'ready') { fail(view.reason); return; }
        if (errorPresent(view)) { fail('native-error'); return; }
        if (attempt.clicked && view.input.textContent === '') { finish(attempt, 'submitted', 'submitted'); return; }
        if (view.input.textContent !== attempt.text) { fail('input-rejected'); return; }
        const buttonEnabled = !attempt.clicked && enabled(view.button);
        const buttonHidden = buttonEnabled && hidden(view.button);
        if (Date.now() >= attempt.deadline) { fail(buttonHidden ? 'restricted' : 'timeout'); return; }
        if (buttonEnabled && !buttonHidden) {
          // Native input handlers may have changed the account or composer.
          if (!current()) { fail('not-current'); return; }
          if (!same(inspect(), attempt.view)) { fail('stale-capability'); return; }
          attempt.clicked = true;
          attempt.deadline = Date.now() + 2000;
          view.button.click();
          step(attempt);
          return;
        }
        attempt.timer = setTimeout(() => { attempt.timer = null; step(attempt); }, 100);
      } catch (_) { fail('native-error'); }
    }

    function refresh() {
      if (destroyed) return;
      const view = inspect();
      state(view);
      if (pending && (!current() || !same(view, pending.view))) step(pending);
    }

    function send(message) {
      // Ignore replayed sequences, including a duplicate of the active request.
      if (!message || !Number.isSafeInteger(message.sequence) || message.sequence <= lastSequence) return;
      lastSequence = message.sequence;
      const reject = reason => onResult({ sequence: message.sequence, outcome: 'not-sent', reason });
      if (!Number.isSafeInteger(message.capability) || message.capability < 1 || typeof message.text !== 'string'
        || !message.text.trim() || message.text.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(message.text)) {
        reject('invalid-request'); return;
      }
      if (!current()) { reject('not-current'); return; }
      if (pending) { reject('busy'); return; }
      const view = inspect();
      state(view);
      if (message.capability !== capability) { reject('stale-capability'); return; }
      if (view.reason !== 'ready') { reject(view.reason); return; }
      if (view.input.textContent !== '') { reject('draft-not-empty'); return; }
      try {
        if (errorPresent(view)) { reject('native-error'); return; }
      } catch (_) { reject('composer-unavailable'); return; }
      const attempt = { view, sequence: message.sequence, text: message.text,
        clicked: false, timer: null, deadline: Date.now() + 1000 };
      pending = attempt;
      state(view);
      if (pending !== attempt) return;
      try {
        view.input.textContent = attempt.text;
        inputEvent(view.input, attempt.text);
        step(attempt);
      } catch (_) { finish(attempt, 'not-sent', 'input-rejected'); }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (pending) finish(pending, pending.clicked ? 'uncertain' : 'not-sent', 'disconnected');
    }

    refresh();
    return { refresh, send, destroy };
  };
})(self.FCM);
