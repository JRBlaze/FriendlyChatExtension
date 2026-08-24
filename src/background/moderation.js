// Moderation actions, for viewers who are a moderator or the broadcaster.
//
// Whether the buttons appear at all is decided elsewhere (Twitch reports it in
// USERSTATE, Kick in the channel payload); this module only carries out an
// action that has already been offered, and reports back in plain words.
(function (FCM) {
  'use strict';

  // ── Twitch ──────────────────────────────────────────────────────────────────

  async function twitchUserId(login, record) {
    const data = await FCM.getJson(
      `${FCM.TWITCH_HELIX}/users?login=${encodeURIComponent(login)}`,
      { headers: { Authorization: `Bearer ${record.accessToken}`, 'Client-Id': record.clientId } }
    );
    const user = data && Array.isArray(data.data) ? data.data[0] : null;
    return user ? user.id : null;
  }

  async function moderateTwitch(action, opts, conn, settings) {
    const record = await FCM.auth.usable('twitch', settings);
    if (!record) return { ok: false, reason: 'not-connected' };
    if (!conn.roomId) return { ok: false, reason: 'no-channel' };

    const headers = {
      Authorization: `Bearer ${record.accessToken}`,
      'Client-Id': record.clientId,
      'Content-Type': 'application/json',
    };
    const scope = `broadcaster_id=${encodeURIComponent(conn.roomId)}`
      + `&moderator_id=${encodeURIComponent(record.userId)}`;

    try {
      if (action === 'delete') {
        if (!opts.messageId) return { ok: false, reason: 'no-message' };
        const res = await fetch(
          `${FCM.TWITCH_HELIX}/moderation/chat?${scope}&message_id=${encodeURIComponent(opts.messageId)}`,
          { method: 'DELETE', headers }
        );
        if (res.ok || res.status === 204) return { ok: true, action, target: opts.username };
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'refused', detail: body.message || `HTTP ${res.status}` };
      }

      const userId = opts.userId || await twitchUserId(opts.username, record);
      if (!userId) return { ok: false, reason: 'no-user' };

      if (action === 'unban') {
        const res = await fetch(
          `${FCM.TWITCH_HELIX}/moderation/bans?${scope}&user_id=${encodeURIComponent(userId)}`,
          { method: 'DELETE', headers }
        );
        if (res.ok || res.status === 204) return { ok: true, action, target: opts.username };
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'refused', detail: body.message || `HTTP ${res.status}` };
      }

      // Ban and timeout are the same endpoint; a duration is what makes it a
      // timeout rather than permanent.
      const data = { user_id: userId };
      if (action === 'timeout') data.duration = Math.max(1, Number(opts.seconds) || 60);
      if (opts.reason) data.reason = String(opts.reason).slice(0, 500);

      const res = await fetch(`${FCM.TWITCH_HELIX}/moderation/bans?${scope}`, {
        method: 'POST', headers, body: JSON.stringify({ data }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: 'refused', detail: body.message || `HTTP ${res.status}` };
      return { ok: true, action, target: opts.username, seconds: data.duration };
    } catch (e) {
      return { ok: false, reason: 'network', detail: e.message };
    }
  }

  // ── Kick ────────────────────────────────────────────────────────────────────

  // Kick's moderation endpoint wants the target's numeric id, and the only
  // public way from a username to that id is their own channel record.
  async function kickUserId(username) {
    const data = await FCM.kickApi.channel(username);
    return data ? Number(data.user_id) || null : null;
  }

  async function moderateKick(action, opts, conn, settings) {
    const record = await FCM.auth.usable('kick', settings);
    if (!record) return { ok: false, reason: 'not-connected' };
    if (!conn.roomId) return { ok: false, reason: 'no-channel' };

    const headers = {
      Authorization: `Bearer ${record.accessToken}`,
      'Content-Type': 'application/json',
    };

    try {
      if (action === 'delete') {
        if (!opts.messageId) return { ok: false, reason: 'no-message' };
        const res = await fetch(
          `${FCM.KICK_API}/chat/${encodeURIComponent(opts.messageId)}`,
          { method: 'DELETE', headers }
        );
        if (res.ok || res.status === 204) return { ok: true, action, target: opts.username };
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'refused', detail: body.message || `HTTP ${res.status}` };
      }

      const userId = opts.userId || await kickUserId(opts.username);
      if (!userId) return { ok: false, reason: 'no-user' };

      const payload = {
        broadcaster_user_id: Number(conn.roomId),
        user_id: Number(userId),
      };
      // Kick takes the timeout in whole minutes, so anything under a minute
      // still costs the viewer a minute — the menu labels say as much.
      if (action === 'timeout') {
        payload.duration = Math.max(1, Math.ceil((Number(opts.seconds) || 60) / 60));
      }

      const res = await fetch(`${FCM.KICK_API}/moderation/bans`, {
        method: action === 'unban' ? 'DELETE' : 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: 'refused', detail: body.message || `HTTP ${res.status}` };
      return { ok: true, action, target: opts.username, seconds: opts.seconds };
    } catch (e) {
      return { ok: false, reason: 'network', detail: e.message };
    }
  }

  FCM.moderate = function (platform, action, opts, conn, settings) {
    if (platform === 'twitch') return moderateTwitch(action, opts || {}, conn, settings);
    if (platform === 'kick') return moderateKick(action, opts || {}, conn, settings);
    return Promise.resolve({ ok: false, reason: 'unsupported' });
  };

  // Turns a result into the line that goes in the feed.
  FCM.describeModeration = function (platform, result) {
    const name = FCM.PLATFORM_META[platform].name;
    const who = result.target || 'that viewer';
    if (result.ok) {
      if (result.action === 'delete') return `${name}: deleted a message from ${who}`;
      if (result.action === 'unban') return `${name}: lifted the ban on ${who}`;
      if (result.action === 'ban') return `${name}: banned ${who}`;
      if (result.action === 'timeout') {
        const s = Number(result.seconds) || 0;
        const pretty = s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
        return `${name}: timed ${who} out for ${pretty}`;
      }
      return `${name}: done`;
    }
    const detail = {
      'not-connected': `connect a ${name} account to moderate`,
      'no-channel': `${name} chat is not connected here`,
      'no-user': `could not find ${who} on ${name}`,
      'no-message': 'no message to delete — click the name on the message you mean',
      refused: result.detail || `${name} refused the action`,
      network: `could not reach ${name}`,
    }[result.reason] || result.detail || 'the action failed';
    return `${name}: ${detail}`;
  };
})(self.FCM);
