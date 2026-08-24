// Sending a typed message to Twitch and/or Kick using the connected accounts.
//
// Neither call is echoed back into the feed here: both platforms send the
// message back down the chat socket a moment later, and adding it locally too
// would show it twice.
(function (FCM) {
  'use strict';

  async function sendTwitch(text, conn, settings) {
    const record = await FCM.auth.usable('twitch', settings);
    if (!record) return { ok: false, reason: 'not-connected' };
    if (!conn.roomId) return { ok: false, reason: 'no-channel' };

    const headers = {
      Authorization: `Bearer ${record.accessToken}`,
      'Client-Id': record.clientId,
      'Content-Type': 'application/json',
    };

    let res;
    try {
      res = await fetch(`${FCM.TWITCH_HELIX}/chat/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          // ROOMSTATE gave us the broadcaster id when the channel was joined,
          // so no extra lookup is needed here.
          broadcaster_id: conn.roomId,
          sender_id: record.userId,
          message: text,
        }),
      });
    } catch (e) {
      return { ok: false, reason: 'network', detail: e.message };
    }

    if (res.status === 401) {
      await FCM.auth.clear('twitch');
      return { ok: false, reason: 'expired' };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: 'rejected', detail: data.message || `HTTP ${res.status}` };
    }
    // Twitch accepts the request but reports is_sent:false when its own filters
    // drop the message, which is not the same thing as success.
    const entry = Array.isArray(data.data) ? data.data[0] : null;
    if (entry && entry.is_sent === false) {
      const why = entry.drop_reason && entry.drop_reason.message;
      return { ok: false, reason: 'dropped', detail: why || 'Twitch dropped the message' };
    }
    return { ok: true };
  }

  async function sendKick(text, conn, settings) {
    const record = await FCM.auth.usable('kick', settings);
    if (!record) return { ok: false, reason: 'not-connected' };
    if (!conn.roomId) return { ok: false, reason: 'no-channel' };

    let res;
    try {
      res = await fetch(`${FCM.KICK_API}/chat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${record.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'user',
          content: text,
          broadcaster_user_id: Number(conn.roomId),
        }),
      });
    } catch (e) {
      return { ok: false, reason: 'network', detail: e.message };
    }

    if (res.status === 401) {
      await FCM.auth.clear('kick');
      return { ok: false, reason: 'expired' };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: 'rejected', detail: data.message || `HTTP ${res.status}` };
    }
    if (data.data && data.data.is_sent === false) {
      return { ok: false, reason: 'dropped', detail: 'Kick did not post the message' };
    }
    return { ok: true };
  }

  FCM.sendMessage = async function (platform, text, conn, settings) {
    if (platform === 'twitch') return sendTwitch(text, conn, settings);
    if (platform === 'kick') return sendKick(text, conn, settings);
    return { ok: false, reason: 'unsupported' };
  };
})(self.FCM);
