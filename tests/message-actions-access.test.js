// Keyboard/touch shortcuts without real messages, accounts or clipboard access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, element } = require('./youtube-view.test');
async function run() {
  const { FCM, context } = fixture();
  const feed = element(), panel = element(), input = element(), handlers = new Map(), replies = [];
  const listen = feed.addEventListener.bind(feed);
  feed.addEventListener = (type, fn) => { handlers.set(type, fn); listen(type, fn); };
  FCM.createCompose({ panel, feedEl: feed, inputEl: input, hostPlatform: 'twitch', canModerate: () => false, toast() {},
    onReplyTo: (...args) => replies.push(args) });
  for (const platform of ['twitch', 'kick', 'youtube']) {
    const rendered = FCM.buildMessageEl({ platform, author: 'Viewer', text: 'hello', messageId: platform });
    assert.equal(rendered.tabIndex, 0, 'messages are reachable without hovering');
    const row = element(), author = element(), body = element();
    row.className = 'fcm-msg'; row.dataset = { platform, msgId: platform };
    author.className = 'fcm-author'; author.dataset.name = 'Viewer';
    body.className = 'fcm-body'; body.appendChild({ nodeType: 3, nodeValue: 'hello', matches: () => false });
    row.appendChild(author); row.appendChild(body); feed.appendChild(row);
    let focused = 0;
    row.focus = opts => { focused++; assert.equal(opts.preventScroll, true); feed.fire('focusin', row); };
    feed.fire('focusin', row);
    assert.ok(row.querySelector('.fcm-row-actions'), 'keyboard focus creates shortcuts');
    for (const pointerType of ['mouse', 'pen', undefined]) handlers.get('pointerup')({ pointerType, target: row });
    assert.equal(focused, 0);
    handlers.get('pointerup')({ pointerType: 'touch', target: body });
    assert.equal(focused, 1);
    const controls = row.querySelector('.fcm-row-actions');
    controls.children[0].fire('click'); assert.deepEqual(replies.at(-1), [platform, 'Viewer', platform]);
    controls.children[1].fire('click'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.copied, 'hello');
    const link = { closest: selector => selector === 'a,button' ? link : row };
    handlers.get('pointerup')({ pointerType: 'touch', target: link });
    assert.equal(focused, 1, 'links/buttons keep their own native interaction');
    assert.equal(row.querySelectorAll('.fcm-row-actions').length, 1);
  }
  handlers.get('pointerup')({ pointerType: 'touch', target: element() });
  const css = fs.readFileSync(path.join(__dirname, '../src/content/overlay.css'), 'utf8');
  assert.match(css, /\.fcm-msg:focus-visible\s*\{[^}]*outline:/);
  assert.match(css, /\.fcm-row-actions button:focus-visible\s*\{[^}]*outline:/);
  assert.match(css, /@media\s*\(pointer: coarse\)[\s\S]*\.fcm-row-actions button[^}]*min-height: 44px/);
  console.log('Message action keyboard/touch unit tests passed.');
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
