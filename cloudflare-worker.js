// Friendly Chat Extension — Cloudflare Worker
//
// Kick's token endpoint requires a client secret even when PKCE is used
// (omitting it answers 400, a wrong one answers 401), so the code exchange
// cannot happen in the browser. This keeps the secret here.
//
// It also hands out the two client ids, so neither is written into the
// extension. A client id is not a secret — it travels in every authorise URL
// and on every API call, so anyone running the extension can read it off their
// own network tab — but keeping it here means it lives in one place that can
// be changed in a minute, instead of being published in the source and pinned
// there until every install has taken an update.
//
// Based on the Friendly Chat desktop app's worker, with three changes:
//
//   1. Failures are reported properly. Kick answers a bad token request with
//      400 and an *empty body*, and calling .json() on that threw, so every
//      exchange failure surfaced as "Unexpected end of JSON input" — a message
//      that says nothing about what went wrong. Responses are now read as text
//      first and only parsed if there is something to parse.
//
//   2. /kick-callback bridges the OAuth redirect. Register that URL with Kick
//      once and it never changes, even when the extension's id does. It reads
//      the extension's own redirect out of the state parameter and forwards
//      every parameter Kick returned, unaltered — but only to an address shaped
//      like a browser's own extension sign-in redirect, Chrome's or Firefox's
//      (EXTENSION_REDIRECTS, below), so it cannot be used to send anybody
//      anywhere else.
//
//   3. /kick-authorize starts that same sign-in for Firefox. Firefox will not
//      open a sign-in window for a link whose redirect_uri is anything but the
//      add-on's own address, and /kick-callback is not that, so the extension
//      sends Firefox here with no redirect_uri at all and this adds the client
//      id and the callback before passing the viewer on to Kick. /kick-config
//      lists it under `features`, which is how the extension tells a worker
//      that has it from one deployed before it existed.
//
// Deploy:
//   npm install -g wrangler
//   wrangler login
//   wrangler secret put KICK_CLIENT_ID
//   wrangler secret put KICK_CLIENT_SECRET
//   wrangler secret put TWITCH_CLIENT_ID
//   wrangler deploy
//
// Redeploy before releasing an extension that signs Firefox in through
// /kick-authorize. Everything here only adds to what the worker answers, so an
// older extension keeps working against a newer worker; it is a newer extension
// in front of an older worker that fails, and it says to redeploy when it does.
//
// Optionally, ALLOWED_REDIRECT_HOSTS — a comma-separated list of exact hosts,
// set as a var or with wrangler secret put — narrows what /kick-callback
// forwards to down to those extensions alone. Unset, which is the default, any
// Chrome or Firefox extension's address is forwarded to, as a fork using the
// shared proxy needs.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // Says which of the three values are set without ever echoing one back, so
    // a deployment can be checked from a browser and a missing secret is a
    // sentence rather than a sign-in that fails much later for no stated
    // reason.
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        service: 'friendly-chat-proxy',
        kick_client_id: Boolean(env.KICK_CLIENT_ID),
        kick_client_secret: Boolean(env.KICK_CLIENT_SECRET),
        twitch_client_id: Boolean(env.TWITCH_CLIENT_ID),
      }, 200, origin);
    }

    // The client id is public; the secret never leaves this worker.
    //
    // `features` says what this deployment can do beyond that. The extension is
    // updated separately from the worker and can assume neither is current, so
    // before it sends Firefox to /kick-authorize it checks that this worker has
    // one — rather than finding out from a 404 page inside a sign-in window.
    if (url.pathname === '/kick-config' && request.method === 'GET') {
      return json({
        client_id: env.KICK_CLIENT_ID || '',
        features: ['kick-authorize', 'allizom-redirect'],
      }, 200, origin);
    }

    // Twitch needs no secret — the implicit grant is a public-client flow — so
    // this is only about where the id lives. An empty answer is not an error
    // here: the extension turns it into a sentence naming the secret to set.
    if (url.pathname === '/twitch-config' && request.method === 'GET') {
      return json({ client_id: env.TWITCH_CLIENT_ID || '' }, 200, origin);
    }

    // ── Sign-in start, for Firefox ───────────────────────────────────────────
    // Firefox checks a sign-in link before it opens anything, and refuses one
    // whose redirect_uri is not the add-on's own address; a link with none is
    // taken to mean that address. So the extension sends Firefox here without
    // one, and this puts Kick's in and bounces on to Kick.
    //
    // The client id and the redirect come from this worker and never from the
    // caller, and where it bounces to is written here, so the link can only
    // ever lead to Kick's own consent page, returning to this worker. The state
    // has to name an address /kick-callback will forward to, or the viewer
    // would be walked through Kick's consent only to be stopped at the end.
    if (url.pathname === '/kick-authorize' && request.method === 'GET') {
      if (!env.KICK_CLIENT_ID) return htmlError('This proxy holds no Kick client id.');
      const state = url.searchParams.get('state') || '';
      if (!decodeTarget(state, env)) {
        return htmlError('This sign-in link did not name a browser-extension address this proxy returns to. '
          + 'Start the sign-in again from the extension.');
      }
      const to = new URL('https://id.kick.com/oauth/authorize');
      to.searchParams.set('response_type', 'code');
      to.searchParams.set('client_id', env.KICK_CLIENT_ID);           // from the worker, never the caller
      to.searchParams.set('redirect_uri', `${url.origin}/kick-callback`); // from the worker, never the caller
      ['scope', 'code_challenge', 'code_challenge_method', 'state'].forEach((k) => {
        const v = url.searchParams.get(k);
        if (v !== null) to.searchParams.set(k, v);
      });
      return Response.redirect(to.toString(), 302);
    }

    // ── Redirect bridge ──────────────────────────────────────────────────────
    // Kick redirects here after the user authorises. The extension put its own
    // redirect in the state parameter, so this hands control back to it with
    // everything Kick returned still attached.
    if (url.pathname === '/kick-callback' && request.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const target = decodeTarget(state, env);
      if (!target) {
        return htmlError('This sign-in link did not name a browser-extension address this proxy returns to. '
          + 'Start the sign-in again from the extension.');
      }
      const back = new URL(target);
      url.searchParams.forEach((value, key) => back.searchParams.set(key, value));
      return Response.redirect(back.toString(), 302);
    }

    if (url.pathname === '/kick-token' && request.method === 'POST') {
      const missing = missingSecrets(env);
      if (missing) return json({ error: missing }, 500, origin);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'Request body was not valid JSON.' }, 400, origin);
      }
      const { code, code_verifier, redirect_uri } = body || {};
      if (!code || !code_verifier || !redirect_uri) {
        return json({
          error: 'Missing code, code_verifier or redirect_uri in the request.',
        }, 400, origin);
      }

      return exchange(env, origin, {
        grant_type: 'authorization_code',
        client_id: env.KICK_CLIENT_ID,
        client_secret: env.KICK_CLIENT_SECRET,
        redirect_uri,
        code_verifier,
        code,
      });
    }

    if (url.pathname === '/kick-refresh' && request.method === 'POST') {
      const missing = missingSecrets(env);
      if (missing) return json({ error: missing }, 500, origin);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'Request body was not valid JSON.' }, 400, origin);
      }
      if (!body || !body.refresh_token) {
        return json({ error: 'Missing refresh_token in the request.' }, 400, origin);
      }

      return exchange(env, origin, {
        grant_type: 'refresh_token',
        client_id: env.KICK_CLIENT_ID,
        client_secret: env.KICK_CLIENT_SECRET,
        refresh_token: body.refresh_token,
      });
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};

function missingSecrets(env) {
  if (env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET) return null;
  return 'Worker secrets not configured — run: wrangler secret put KICK_CLIENT_ID '
    + '&& wrangler secret put KICK_CLIENT_SECRET';
}

/**
 * Posts to Kick's token endpoint and reports whatever comes back in a form the
 * extension can act on.
 *
 * Kick answers a rejected request with 400 and no body at all, so the response
 * is read as text and only parsed when there is something to parse. Without
 * that, every failure became "Unexpected end of JSON input".
 */
async function exchange(env, origin, params) {
  let kickRes;
  let raw;
  try {
    kickRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    });
    raw = await kickRes.text();
  } catch (e) {
    return json({ error: `Could not reach Kick: ${e.message}` }, 502, origin);
  }

  let data = null;
  if (raw && raw.trim()) {
    try { data = JSON.parse(raw); } catch (e) { data = null; }
  }

  if (!kickRes.ok) {
    // Prefer Kick's own words; fall back to the status, which is itself
    // meaningful — 401 means the client secret is wrong, 400 means the code,
    // verifier or redirect_uri did not line up.
    const detail = (data && (data.error_description || data.error || data.message))
      || (raw && raw.trim().slice(0, 300))
      || describeStatus(kickRes.status);
    // Only 400 and 401 are Kick saying this token or this request is finished,
    // and only those two may be passed through as themselves: the extension
    // reads them as "the sign-in is spent" and deletes the account. Everything
    // else — 429 when every user of this client id shares a rate limit, 5xx
    // during a Kick incident, 403 when Cloudflare puts a challenge in front of
    // id.kick.com, 404 if the endpoint ever moves — is a service having a bad
    // day, and is reported as one so the account outlives it. Flattening those
    // to 400 threw away a still-valid refresh token and made the viewer sign in
    // again for a failure that had already gone away.
    const refused = kickRes.status === 400 || kickRes.status === 401;
    return json({
      error: detail,
      status: kickRes.status,
      hint: hintForStatus(kickRes.status, params.grant_type),
    }, refused ? kickRes.status : 502, origin);
  }

  if (!data || !data.access_token) {
    return json({
      error: 'Kick accepted the request but returned no access token.',
      status: kickRes.status,
    }, 502, origin);
  }

  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  }, 200, origin);
}

function describeStatus(status) {
  if (status === 400) return 'Kick rejected the request (400) without saying why.';
  if (status === 401) return 'Kick rejected the client credentials (401).';
  if (status === 404) return 'Kick token endpoint not found (404).';
  return `Kick returned HTTP ${status}.`;
}

function hintForStatus(status, grantType) {
  if (status === 401) {
    return 'The client secret this worker holds does not match its client id. '
      + 'Re-run: wrangler secret put KICK_CLIENT_SECRET';
  }
  if (status === 400 && grantType === 'authorization_code') {
    return 'Usually the redirect_uri does not exactly match the one registered '
      + 'with the Kick application, or the code has already been used.';
  }
  if (status === 400) return 'The refresh token is no longer valid; sign in again.';
  return '';
}

// The only places /kick-callback will send a browser back to: a browser's own
// extension sign-in redirect. Anything else would make this an open redirect.
//   Chrome:  https://<32 letters a-p>.chromiumapp.org/          (the extension ID)
//   Firefox: https://<40 lowercase hex>.extensions.allizom.org/ (SHA-1 of the add-on ID)
//
// Each is anchored at both ends, https only, with a host label of fixed length
// and alphabet under a parent domain the browser's vendor owns, and a path of
// "/" or nothing. So nothing can follow it or be slipped in front of it: no
// port, no userinfo, no extra label, no query and no fragment. Firefox's other
// accepted form, http://127.0.0.1/mozoauth2/<hash>, is left out on purpose — it
// is plain http to the machine's own loopback, and the extension never uses it.
// Both addresses are ones the browser's own sign-in window catches rather than
// loads. This is the same trust the Chrome pattern alone always gave: any
// extension's address, not only this one's (ALLOWED_REDIRECT_HOSTS narrows it).
const EXTENSION_REDIRECTS = [
  /^https:\/\/[a-p]{32}\.chromiumapp\.org\/?$/,
  /^https:\/\/[0-9a-f]{40}\.extensions\.allizom\.org\/?$/,
];

// The extension encodes where to return as "<nonce>~<base64url of its redirect>".
// Only an address in EXTENSION_REDIRECTS is honoured, so this cannot be turned
// into an open redirect to anywhere on the web.
function decodeTarget(state, env) {
  const marker = state.indexOf('~');
  if (marker === -1) return null;
  const encoded = state.slice(marker + 1);
  if (!encoded) return null;
  let decoded;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    decoded = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch (e) {
    return null;
  }
  if (!EXTENSION_REDIRECTS.some((re) => re.test(decoded))) return null;
  // A deployment that means to serve only its own extensions lists their hosts.
  // It can only narrow the shapes above, never add to them.
  const pinned = String((env && env.ALLOWED_REDIRECT_HOSTS) || '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (pinned.length && !pinned.includes(new URL(decoded).host)) return null;
  return decoded;
}

function htmlError(message) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Sign-in problem</title>`
    + `<body style="font-family:system-ui;padding:2rem;max-width:34rem">`
    + `<h1 style="font-size:1.1rem">Sign-in could not be completed</h1>`
    + `<p>${message.replace(/[<>&]/g, '')}</p></body>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}
