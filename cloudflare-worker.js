// Friendly Chat Merge — Cloudflare Worker
//
// Kick's token endpoint requires a client secret even when PKCE is used
// (omitting it answers 400, a wrong one answers 401), so the code exchange
// cannot happen in the browser. This keeps the secret here.
//
// Based on the Friendly Chat desktop app's worker, with two changes:
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
//      every parameter Kick returned, unaltered.
//
// Deploy:
//   npm install -g wrangler
//   wrangler login
//   wrangler secret put KICK_CLIENT_ID
//   wrangler secret put KICK_CLIENT_SECRET
//   wrangler deploy

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'friendly-chat-kick-proxy' }, 200, origin);
    }

    // The client id is public; the secret never leaves this worker.
    if (url.pathname === '/kick-config' && request.method === 'GET') {
      return json({ client_id: env.KICK_CLIENT_ID || '' }, 200, origin);
    }

    // ── Redirect bridge ──────────────────────────────────────────────────────
    // Kick redirects here after the user authorises. The extension put its own
    // redirect in the state parameter, so this hands control back to it with
    // everything Kick returned still attached.
    if (url.pathname === '/kick-callback' && request.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const target = decodeTarget(state);
      if (!target) {
        return htmlError('This sign-in link did not say where to return to. '
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
    return json({
      error: detail,
      status: kickRes.status,
      hint: hintForStatus(kickRes.status, params.grant_type),
    }, kickRes.status === 401 ? 401 : 400, origin);
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

// The extension encodes where to return as "<nonce>~<base64url of its redirect>".
// Only https extension redirects are honoured, so this cannot be turned into an
// open redirect to anywhere on the web.
function decodeTarget(state) {
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
  if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\/?$/.test(decoded)) return null;
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
