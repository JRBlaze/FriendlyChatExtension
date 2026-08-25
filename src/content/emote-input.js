// A message box that shows emotes as emotes.
//
// An `<input>` cannot draw an image, so this is a contenteditable — but nothing
// else in the composer should have to know that. The autocomplete, the emote
// picker, the reply bar and the send path all treat the box as an input, and
// they are right to: `value`, `selectionStart` and `setSelectionRange` are the
// whole vocabulary they need. So those are defined here over the contenteditable
// and every one of those call sites carries on unchanged.
//
// The trick that makes it work is that an emote is worth exactly its own name.
// An <img> counts as `alt.length` characters when reading the value and when
// counting to the caret, so "Kappa" typed and "Kappa" shown as a picture occupy
// the same offsets, and code that slices the value has no idea anything changed.
(function (FCM) {
  'use strict';

  const EMOTE_CLASS = 'fcm-input-emote';

  function isEmoteImg(node) {
    return node.nodeType === 1 && node.nodeName === 'IMG' && node.classList.contains(EMOTE_CLASS);
  }

  // What one node contributes to the value, in characters.
  function lengthOf(node) {
    if (node.nodeType === 3) return node.nodeValue.length;
    if (isEmoteImg(node)) return (node.alt || '').length;
    return (node.textContent || '').length;
  }

  function readValue(el) {
    let out = '';
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3) out += node.nodeValue;
      else if (isEmoteImg(node)) out += node.alt || '';
      else if (node.nodeName === 'BR') out += '';
      else out += node.textContent || '';
    });
    return out;
  }

  /**
   * Rebuilds the box from a plain string, drawing every emote it recognises.
   *
   * Only called for deliberate writes — a completed emote, an insertion from the
   * picker, a reply, a clear. Typing does not come through here, because
   * replacing the contents on every keystroke would take the caret with it.
   */
  function writeValue(el, text) {
    const parts = String(text === null || text === undefined ? '' : text).split(/(\s+)/);
    const frag = document.createDocumentFragment();
    let buffer = '';
    const flush = () => {
      if (!buffer) return;
      frag.appendChild(document.createTextNode(buffer));
      buffer = '';
    };
    parts.forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) { buffer += part; return; }
      const emote = FCM.findEmote ? FCM.findEmote(part) : null;
      if (!emote) { buffer += part; return; }
      flush();
      const img = document.createElement('img');
      img.className = EMOTE_CLASS;
      img.src = emote.url;
      img.alt = part;
      img.title = part;
      img.draggable = false;
      frag.appendChild(img);
    });
    flush();
    el.replaceChildren(frag);
  }

  // The selection, from whichever root actually owns it. The box lives in a
  // shadow root, and a shadow root keeps its own.
  function selectionFor(el) {
    const root = el.getRootNode ? el.getRootNode() : document;
    if (root && typeof root.getSelection === 'function') return root.getSelection();
    return document.getSelection ? document.getSelection() : null;
  }

  // How many characters precede a (node, offset) position inside the box.
  function offsetAt(el, node, offset) {
    if (node === el) {
      let total = 0;
      for (let i = 0; i < offset && i < el.childNodes.length; i++) {
        total += lengthOf(el.childNodes[i]);
      }
      return total;
    }
    let total = 0;
    for (const child of el.childNodes) {
      if (child === node) return total + (child.nodeType === 3 ? offset : 0);
      if (child.contains && child.contains(node)) return total + offset;
      total += lengthOf(child);
    }
    return total;
  }

  function caretOffset(el) {
    const sel = selectionFor(el);
    if (!sel || !sel.rangeCount) return readValue(el).length;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) && range.startContainer !== el) {
      return readValue(el).length;
    }
    return offsetAt(el, range.startContainer, range.startOffset);
  }

  // Turns a character offset back into a place a caret can sit.
  function pointAt(el, target) {
    let remaining = Math.max(0, target);
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      const len = lengthOf(child);
      if (remaining < len || (remaining === len && child.nodeType === 3)) {
        if (child.nodeType === 3) return { node: child, offset: remaining };
        // Landing inside an emote means one side of it or the other.
        return { node: el, offset: remaining === 0 ? i : i + 1 };
      }
      remaining -= len;
    }
    return { node: el, offset: el.childNodes.length };
  }

  function setCaret(el, start, end) {
    const sel = selectionFor(el);
    if (!sel || !document.createRange) return;
    const from = pointAt(el, start);
    const to = pointAt(el, end === undefined ? start : end);
    try {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* the box was emptied under us */ }
  }

  /**
   * Gives a contenteditable the small part of the input interface the composer
   * actually uses, and draws emotes as they are completed.
   *
   * @param {Element} el the contenteditable box
   * @param {object} [options] { maxLength }
   */
  FCM.makeEmoteInput = function (el, options) {
    const settings = options || {};
    const maxLength = settings.maxLength || 0;

    const markEmpty = () => {
      el.classList.toggle('fcm-input-empty', readValue(el).length === 0);
    };

    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return readValue(el); },
      set(next) {
        writeValue(el, next);
        markEmpty();
      },
    });

    ['selectionStart', 'selectionEnd'].forEach((name) => {
      Object.defineProperty(el, name, {
        configurable: true,
        get() { return caretOffset(el); },
      });
    });

    el.setSelectionRange = function (start, end) {
      setCaret(el, start, end === undefined ? start : end);
    };

    Object.defineProperty(el, 'placeholder', {
      configurable: true,
      get() { return el.getAttribute('data-placeholder') || ''; },
      set(text) { el.setAttribute('data-placeholder', text || ''); },
    });

    /**
     * Draws the emote the viewer has just finished typing.
     *
     * The trigger is the separator: a name only becomes a picture once it is
     * clearly finished, so that typing through a longer name that starts with a
     * shorter one is never interrupted.
     */
    function drawCompletedEmote() {
      const value = readValue(el);
      const caret = caretOffset(el);
      const before = value.slice(0, caret);
      const match = /(^|\s)(\S+)(\s)$/.exec(before);
      if (!match) return false;
      if (!FCM.findEmote || !FCM.findEmote(match[2])) return false;
      // Rewriting the whole box is safe here and nowhere else: it happens once
      // per emote rather than once per keystroke, and the caret lands back on
      // the same character because a drawn emote is worth its own name.
      writeValue(el, value);
      setCaret(el, caret);
      return true;
    }

    el.addEventListener('input', () => {
      if (maxLength) {
        const value = readValue(el);
        if (value.length > maxLength) {
          const caret = Math.min(caretOffset(el), maxLength);
          writeValue(el, value.slice(0, maxLength));
          setCaret(el, caret);
        }
      }
      drawCompletedEmote();
      markEmpty();
    });

    // Pasted markup has no business in a chat box, and a pasted newline would
    // turn a single-line composer into a multi-line one.
    el.addEventListener('paste', (e) => {
      if (!e.clipboardData) return;
      e.preventDefault();
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\s*\n+\s*/g, ' ');
      const value = readValue(el);
      const caret = caretOffset(el);
      let next = value.slice(0, caret) + text + value.slice(caret);
      if (maxLength) next = next.slice(0, maxLength);
      writeValue(el, next);
      setCaret(el, Math.min(caret + text.length, next.length));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Dropping a file or a selection into it would do the same.
    el.addEventListener('drop', (e) => e.preventDefault());

    markEmpty();
    return el;
  };
})(self.FCM);
