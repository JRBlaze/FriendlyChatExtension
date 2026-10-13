// Kick's rotated Pusher app: real source, anonymous setup and no live traffic.
const assert = require('node:assert/strict');
const { fixture } = require('./connection-recovery');
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const descriptor = (credentials = { app_key: 'new123', cluster: 'us2' }) => ({
  data: { mode: 'websocket', connections: [{ provider: 'pusher', credentials }] },
});
function realtime(browser) {
  const f = fixture(browser), requests = [], chats = [];
  f.sandbox.AbortController = AbortController;
  f.sandbox.crypto = { randomUUID: () => 'synthetic-reader-id' };
  f.sandbox.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => descriptor() };
  };
  f.sink.chat = row => chats.push(row);
  return { ...f, requests, chats };
}
async function stop(f) { f.FCM.kickSource.disconnect(f.conn); await f.advance(0); }
async function boundaries(browser) {
  for (const data of [null, {}, { data: null }, { data: { mode: 'polling' } },
    { data: { mode: 'websocket', connections: null } },
    { data: { mode: 'websocket', connections: [null, { provider: 'centrifugo' }] } },
    { data: { mode: 'websocket', connections: [{ provider: 'pusher' }] } },
    descriptor({}), descriptor({ app_key: 123, cluster: 'us2' }),
    descriptor({ app_key: 'key' }), descriptor({ app_key: 'key', cluster: 123 }),
    descriptor({ app_key: 'bad/key', cluster: 'us2' }), descriptor({ app_key: 'key', cluster: 'attacker.example' })]) {
    const f = realtime(browser); f.conn.useRealtime = true;
    f.sandbox.fetch = async () => ({ ok: true, json: async () => data });
    await f.connect('kick');
    assert.equal(f.sockets.length, 0); assert.equal(f.delay(f.conn.retryTimer), 2000);
    assert.match(f.said.at(-1), /could not prepare/); await stop(f);
  }
  for (const failure of ['http', 'json', 'network']) {
    const f = realtime(browser); f.conn.useRealtime = true;
    f.sandbox.fetch = async () => {
      if (failure === 'network') throw Error('sensitive server response');
      return { ok: failure !== 'http', json: async () => { throw Error('sensitive server response'); } };
    };
    await f.connect('kick');
    assert.equal(f.sockets.length, 0); assert.equal(f.delay(f.conn.retryTimer), 2000);
    assert.ok(!f.said.some(text => text.includes('sensitive'))); await stop(f);
  }
  // A descriptor can rotate the cluster as well as the public app key.
  {
    const f = realtime(browser); f.conn.useRealtime = true;
    f.sandbox.fetch = async () => ({ ok: true, json: async () => descriptor({ app_key: 'key456', cluster: 'eu' }) });
    await f.connect('kick'); assert.match(f.latest().url, /^wss:\/\/ws-eu\.pusher\.com\/app\/key456\?/);
    await stop(f);
  }
  {
    const f = realtime(browser); f.conn.useRealtime = true; f.info({ chatroom: { id: 12 } });
    await f.connect('kick'); assert.ok(f.requests[0].url.endsWith('/realtime/connection')); await stop(f);
  }
  // Setup requests time out and are cancelled during leave or replacement.
  for (const action of ['timeout', 'disconnect', 'replace', 'force', 'stale-error', 'late-success']) {
    const f = realtime(browser); f.conn.useRealtime = true;
    let resolve, reject, signal; const original = f.sandbox.fetch;
    f.sandbox.fetch = async (url, init) => {
      signal = init.signal;
      return new Promise((yes, no) => {
        resolve = yes; reject = no;
        if (action !== 'late-success') signal.addEventListener('abort', () => no(Error('aborted')));
      });
    };
    const connecting = f.connect('kick'); await settle();
    if (action === 'timeout') { await f.advance(10000); await settle(); }
    else if (action === 'force') { f.conn.forceClose = true; resolve({ ok: true, json: async () => descriptor() }); }
    else if (action === 'stale-error') { f.conn.generation++; reject(Error('obsolete failure')); }
    else if (action === 'disconnect') f.FCM.kickSource.disconnect(f.conn);
    else if (action === 'late-success') { f.FCM.kickSource.disconnect(f.conn); resolve({ ok: true, json: async () => descriptor() }); }
    else { f.sandbox.fetch = original; await f.connect('kick'); assert.equal(signal.aborted, true); }
    await connecting;
    if (action === 'timeout') assert.equal(f.delay(f.conn.retryTimer), 2000);
    else assert.equal(f.conn.retryTimer || null, null, 'cancelled setup cannot retry');
    await stop(f); assert.equal(f.timers.size, 0);
  }
  // Repeated setup failures still respect the existing retry cooldown.
  {
    const f = realtime(browser); f.conn.useRealtime = true; f.conn.attempt = f.FCM.MAX_RECONNECT_ATTEMPTS;
    f.sandbox.fetch = async () => ({ ok: false });
    await f.connect('kick'); assert.equal(f.delay(f.conn.retryTimer), f.FCM.RECONNECT_COOLDOWN_MS);
    await stop(f);
  }
  // Other Pusher errors cannot trigger an unbounded immediate migration loop.
  for (const data of [null, { code: 4004 }, JSON.stringify({ code: 4004 })]) {
    const f = realtime(browser); await f.connect('kick'); f.latest().push('pusher:error', data);
    await f.advance(0); assert.equal(f.delay(f.conn.retryTimer), 2000);
    assert.equal(f.requests.length, 0); await stop(f);
  }
  {
    const f = realtime(browser); f.conn.useRealtime = true; await f.connect('kick');
    f.latest().push('pusher:error', JSON.stringify({ code: 4001 })); await f.advance(0);
    assert.equal(f.delay(f.conn.retryTimer), 2000); await stop(f);
  }
  // An outgoing socket cannot clear the replacement's setup request.
  {
    const f = realtime(browser); await f.connect('kick'); const ws = f.latest();
    for (const data of ['not-json', 'null', '{}']) ws.onmessage({ data });
    ws.onerror(); ws.push('pusher:connection_established', '{}'); ws.push('pusher:connection_established', '{}');
    for (const data of [{ message: { id: 'deleted' } }, { id: 'root-id' }, {}, null]) {
      ws.push('App\\Events\\MessageDeletedEvent', JSON.stringify(data));
    }
    for (const data of [{ user: { username: 'banned' } }, { banned_user: { username: 'fallback' } }, {}, null]) {
      ws.push('App\\Events\\UserBannedEvent', JSON.stringify(data));
    }
    ws.push('App\\Events\\SubscriptionEvent', JSON.stringify({ username: 'Subscriber' }));
    ws.push('App\\Events\\StreamerIsLive', '{}');
    for (const data of [{}, { content: 'plain' }, { content: 'with sender', sender: {} },
      { content: 'fallbacks', message_id: 'fallback', sender: { user_id: 4, identity: {} } },
      { content: '[emote:1:One] [emote:2:Two]', id: 'rich', created_at: '2026-10-13T12:00:00Z',
        emotes: [null, {}, { id: 1 }, { id: 1, name: 'One' }],
        sender: { id: 1, username: 'Guest', identity: { color: '#fff', badges: [{ type: 'moderator' }] } } }]) {
      ws.push('App\\Events\\ChatMessageEvent', JSON.stringify(data));
    }
    assert.equal(f.chats.length, 4);
    f.conn.forceClose = true; ws.drop();
    assert.equal(f.conn.retryTimer || null, null);
    await stop(f); ws.onerror(); ws.push('pusher:ping');
  }
  {
    const f = realtime(browser); await f.connect('kick'); const old = f.latest();
    f.conn.useRealtime = true;
    let resolve, signal;
    f.sandbox.fetch = async (url, init) => {
      signal = init.signal;
      return new Promise(yes => { resolve = yes; });
    };
    const connecting = f.connect('kick'); await settle();
    old.onclose();
    assert.equal(signal.aborted, false, 'a stale socket cannot abort the new descriptor request');
    const lateTimeout = [...f.timers.values()].find(timer => timer.delay === 10000).fn;
    resolve({ ok: true, json: async () => descriptor() }); await connecting;
    assert.doesNotThrow(lateTimeout, 'a queued timeout remains harmless after setup settles');
    await stop(f);
  }
  {
    const f = realtime(browser); await f.connect('kick'); const old = f.latest();
    const onclose = old.onclose; old.push('pusher:error', JSON.stringify({ code: 4001 }));
    await f.advance(0); await settle(); const current = f.latest();
    onclose(); assert.equal(f.conn.ws, current);
    current.push('pusher:connection_established', '{}');
    current.push('App\\Events\\ChatMessageEvent', JSON.stringify({ content: 'still here', sender: { username: 'Guest' } }));
    assert.equal(f.chats.at(-1).text, 'still here');
    await stop(f); assert.equal(f.timers.size, 0);
  }
}
async function run() {
  for (const browser of ['chrome', 'firefox']) {
    await boundaries(browser);
    const f = realtime(browser); await f.connect('kick'); const obsolete = f.latest();
    obsolete.push('pusher:error', { code: 4001, message: 'obsolete application' });
    assert.equal(obsolete.readyState, 3);
    await f.advance(0); await settle(); const ws = f.latest();
    assert.match(ws.url, /^wss:\/\/ws-us2\.pusher\.com\/app\/new123\?/);
    assert.equal(f.requests.length, 1);
    const { url, init } = f.requests[0];
    assert.ok(url.endsWith('/channels/10/chat/connection'));
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(init.body), { client: { id: 'synthetic-reader-id', type: 'web' },
      capabilities: { accepted_providers: [{ provider: 'pusher' }] } });
    ws.push('pusher:connection_established', '{}');
    const sent = ws.sent.map(text => JSON.parse(text));
    assert.deepEqual(sent.map(msg => msg.data.channel), ['chatrooms.12.v2', 'channel.10']);
    assert.equal(f.states.at(-1), 'connected');
    await f.advance(25000); assert.equal(JSON.parse(ws.sent.at(-1)).event, 'pusher:ping');
    ws.push('pusher:pong');
    const deadline = f.callback(f.conn.pongTimer);
    await f.connect('kick'); assert.equal(f.requests.length, 2);
    assert.equal(JSON.parse(f.requests[1].init.body).client.id, 'synthetic-reader-id');
    assert.equal(deadline, undefined);
    await stop(f); assert.equal(f.timers.size, 0);
  }
  const { bootWorker, wait } = require('./background');
  for (const browser of ['chrome', 'firefox']) {
    const w = bootWorker({ browser, loadPath: browser === 'firefox' ? 'scripts' : 'worker' });
    try {
      const original = w.sandbox.fetch;
      w.sandbox.AbortController = AbortController; w.sandbox.crypto.randomUUID = () => 'synthetic-coordinator-id';
      w.sandbox.fetch = async (url, init) => String(url).includes('/realtime/')
        ? { ok: true, json: async () => descriptor() } : original(url, init);
      w.connect(); w.send({ cmd: 'hello', site: 'twitch', channel: 'alpha', hints: [] }); await wait(30);
      w.send({ cmd: 'join', platform: 'twitch', channel: 'alpha' });
      w.send({ cmd: 'join', platform: 'kick', channel: 'alpha' }); await wait(30);
      const twitch = w.socketFor('irc-ws'), obsolete = w.socketFor('pusher');
      obsolete.push(JSON.stringify({ event: 'pusher:error', data: { code: 4001 } })); await wait(30);
      const ws = w.socketsFor('pusher').at(-1); assert.ok(ws !== obsolete); assert.match(ws.url, /app\/new123/);
      ws.push(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
      ws.push(JSON.stringify({ event: 'App\\Events\\ChatMessageEvent', data: JSON.stringify({ content: 'new Kick transport', sender: { username: 'Guest' } }) }));
      twitch.push('@id=still;display-name=Guest :guest!guest@host PRIVMSG #alpha :Twitch remains connected\r\n');
      assert.ok(w.of('chat').some(({ msg }) => msg.text === 'new Kick transport' && msg.platform === 'kick'));
      assert.ok(w.of('chat').some(({ msg }) => msg.text === 'Twitch remains connected' && msg.platform === 'twitch'));
      assert.equal(w.socketsFor('irc-ws').length, 1);
      w.send({ cmd: 'leave', platform: 'kick' }); await wait(10);
      assert.equal(ws.closed, true); assert.equal(twitch.closed, false);
    } finally { w.teardown(); }
  }
  console.log('Kick Pusher migration tests passed (Chrome and Firefox source modes).');
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
