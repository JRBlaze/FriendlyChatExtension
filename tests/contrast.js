// WCAG AA contrast auditor for the overlay, the options page and the popup.
//
// It measures what is actually rendered rather than reading the stylesheet,
// which matters here: the panel ships at 96% opacity and several states used to
// be dimmed with `opacity`, and both compound down the ancestor chain in a way
// no reading of the CSS reveals. Backgrounds and inherited opacity are
// composited the way the screen composites them.
//
// Load it into the harness (or either page) and call:
//
//     __auditContrast([shadowRootOrDocument])   -> [] when everything passes
//
// Anything it returns is text below 4.5:1 (or 3:1 for large text).
//
// Transitions are suspended for the duration of the measurement and restored
// afterwards. This used to be the caller's job and it was the wrong place for
// it: a colour mid-transition reads as its start value, and in a window that is
// not compositing it never finishes at all — so a transitioned property reads
// as the browser default forever. That is not a subtle failure. It reported the
// overlay's balance chips at 1.07:1 against a white background they have never
// been drawn on, and the instruction to prevent it lived only in this comment,
// where a caller had to notice it and act on it.
window.__auditContrast = function (roots) {
  const parse = (c) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c || '');
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  // Everything painted behind this element, composited bottom-up.
  function backdrop(el) {
    const chain = [];
    for (let n = el; n; n = n.parentElement || (n.getRootNode() && n.getRootNode().host) || null) {
      chain.push(n);
      if (n === document.documentElement) break;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = chain.length - 1; i >= 0; i--) {
      const cs = getComputedStyle(chain[i]);
      const bg = parse(cs.backgroundColor);
      const op = parseFloat(cs.opacity);
      if (bg && bg.a > 0) {
        const eff = { ...bg, a: bg.a * (Number.isFinite(op) ? op : 1) };
        base = over(eff, base);
      }
    }
    return base;
  }

  function cumulativeOpacity(el) {
    let o = 1;
    for (let n = el; n; n = n.parentElement || (n.getRootNode() && n.getRootNode().host) || null) {
      const v = parseFloat(getComputedStyle(n).opacity);
      if (Number.isFinite(v)) o *= v;
      if (n === document.documentElement) break;
    }
    return o;
  }

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function ownText(el) {
    let t = '';
    el.childNodes.forEach((n) => { if (n.nodeType === 3) t += n.textContent; });
    return t.replace(/\s+/g, ' ').trim();
  }

  /**
   * Stops every transition and animation in a root for the duration of the
   * measurement, and hands back the undo.
   *
   * Reading a transitioned colour is reading wherever the transition has got
   * to, which in a window that is not compositing is nowhere at all.
   */
  function freeze(roots) {
    const added = [];
    roots.forEach((root) => {
      const target = root.nodeType === 9 ? root.head || root.documentElement : root;
      if (!target || !target.appendChild) return;
      const style = (root.ownerDocument || document).createElement('style');
      style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
      target.appendChild(style);
      added.push(style);
    });
    // Force the recalculation now, so the first element measured is already
    // reading its settled colour rather than the one it was mid-way to.
    if (document.documentElement) void document.documentElement.offsetHeight;
    return () => added.forEach((style) => style.remove());
  }

  const out = [];
  const seen = new Set();
  // Called with nothing, audit the page: that is what the options page and the
  // popup need, and they have no shadow root to hand in.
  const targets = (roots && roots.length ? roots : [document]);
  const thaw = freeze(targets);
  targets.forEach((root) => {
    root.querySelectorAll('*').forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const text = ownText(el);
      if (!text) return;
      if (!visible(el)) return;
      const cs = getComputedStyle(el);
      const col = parse(cs.color);
      if (!col) return;
      const op = cumulativeOpacity(el);
      if (op < 0.06) return;              // effectively invisible, not a contrast issue
      const bg = backdrop(el);
      const fg = over({ ...col, a: col.a * op }, bg);
      const size = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      const got = ratio(fg, bg);
      if (got >= need) return;
      out.push({
        sel: (el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')).slice(0, 60),
        text: text.slice(0, 28),
        size: +size.toFixed(1),
        weight,
        got: +got.toFixed(2),
        need,
        color: cs.color,
        opacity: +op.toFixed(2),
      });
    });
  });
  thaw();
  out.sort((a, b) => a.got - b.got);
  return out;
};
