// Account connection for Twitch and Kick.
//
// Reading chat needs no account at all — that stays anonymous. This is only for
// *sending*, which both platforms require a real user token for.
//
// Twitch uses the implicit grant, so a client id is enough and the token comes
// straight back in the redirect fragment. Kick uses OAuth 2.1 with PKCE, and
// its token exchange requires a client secret, so the code is exchanged through
// the same Cloudflare Worker the desktop app uses; the secret stays there.
(function (FCM) {
  'use strict';

  function redirectUri() {
    return chrome.identity.getRedirectURL();
  }

  /**
   * Turns a provider's failure into something that says what to do about it.
   *
   * Both platforms reject an unregistered redirect, but neither says so in a
   * way that points anywhere useful: Twitch refuses to render the page at all
   * ("Authorization page could not be loaded") and Kick answers "invalid
   * redirect uri". By far the most common cause of either is that the
   * extension's redirect URL has not been added to the app, so that is what
   * the message explains — with the exact URL to paste.
   */
  FCM.explainAuthFailure = function (platform, rawMessage, authUrl) {
    const raw = String(rawMessage || '');
    const name = FCM.PLATFORM_META[platform].name;
    const uri = redirectUri();

    const redirectProblem = /redirect|could not be loaded|invalid.?uri|mismatch/i.test(raw);
    if (redirectProblem) {
      return {
        needsRedirectSetup: true,
        redirectUri: uri,
        authUrl: authUrl || '',
        // Worth spelling out, because the symptom is genuinely misleading: when
        // the redirect is not registered, Twitch does not show an error. It
        // sends the browser to whichever redirect *is* registered, carrying
        // ?error=redirect_mismatch. That page usually fails to load, and Chrome
        // reports only "Authorization page could not be loaded" — which says
        // nothing about the real cause.
        message: `${name} did not accept this extension's redirect URL, so the sign-in could not `
          + `finish. If the window flashed a page that failed to load, its address bar would have `
          + `read "error=redirect_mismatch" — that is this. Add this exact URL to the ${name} app's `
          + `OAuth redirect list and try again:`,
        raw,
      };
    }

    if (/closed|cancel/i.test(raw)) {
      return { needsRedirectSetup: false, redirectUri: uri, message: `${name} sign-in was cancelled.`, raw };
    }
    if (/proxy/i.test(raw)) {
      return {
        needsRedirectSetup: false,
        redirectUri: uri,
        message: `Could not reach the Kick proxy that performs the token exchange. `
          + `Check its URL in the extension options.`,
        raw,
      };
    }
    return {
      needsRedirectSetup: false, redirectUri: uri, authUrl: authUrl || '',
      message: `${name} sign-in failed: ${raw}`, raw,
    };
  };

  // ── Token storage ───────────────────────────────────────────────────────────

  async function readAuth() {
    try {
      const stored = await chrome.storage.local.get(FCM.STORAGE_KEYS.auth);
      return stored[FCM.STORAGE_KEYS.auth] || {};
    } catch (e) {
      return {};
    }
  }

  async function writeAuth(patch) {
    const current = await readAuth();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [FCM.STORAGE_KEYS.auth]: next });
    return next;
  }

  FCM.auth = {
    async get(platform) {
      const all = await readAuth();
      return all[platform] || null;
    },

    async all() {
      return readAuth();
    },

    async set(platform, record) {
      return writeAuth({ [platform]: record });
    },

    async clear(platform) {
      const current = await readAuth();
      delete current[platform];
      await chrome.storage.local.set({ [FCM.STORAGE_KEYS.auth]: current });
      return current;
    },

    // What the UI needs to know, without ever handing it a token.
    async summary() {
      const all = await readAuth();
      const out = {};
      FCM.SEND_PLATFORMS.forEach((p) => {
        const record = all[p];
        out[p] = record && record.accessToken
          ? { connected: true, login: record.login || '', userId: record.userId || '' }
          : { connected: false, login: '', userId: '' };
      });
      return out;
    },
  };

  // ── PKCE ────────────────────────────────────────────────────────────────────

  function base64url(buf) {
    let binary = '';
    new Uint8Array(buf).forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function generatePkce() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: base64url(digest) };
  }

  function launch(url) {
    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirect) => {
        // The URL travels with the failure so the overlay can offer it: opening
        // it in an ordinary tab is the one test that distinguishes "the platform
        // rejected this" from "the sign-in window itself would not load".
        const fail = (message) => {
          const err = new Error(message);
          err.authUrl = url;
          reject(err);
        };
        if (chrome.runtime.lastError) { fail(chrome.runtime.lastError.message); return; }
        if (!redirect) { fail('The sign-in window was closed before it finished.'); return; }
        resolve(redirect);
      });
    });
  }

  /**
   * Runs a sign-in that ends at a redirect chrome.identity cannot handle.
   *
   * launchWebAuthFlow only ever completes on `https://<id>.chromiumapp.org/`,
   * so it cannot be used with the redirect the desktop app registers. Opening
   * an ordinary tab and watching where it goes works instead — and works even
   * though nothing is listening on that address, because the tab's URL changes
   * to the redirect before the load fails. That is where the code is.
   *
   * @param {string} authUrl        where to send the user
   * @param {string} redirectPrefix the redirect to watch for
   */
  function launchViaTab(authUrl, redirectPrefix) {
    return new Promise((resolve, reject) => {
      let tabId = null;
      let settled = false;

      const fail = (message) => {
        const err = new Error(message);
        err.authUrl = authUrl;
        finish(() => reject(err));
      };

      function finish(action) {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        clearInterval(poll);
        clearTimeout(timer);
        if (tabId != null) {
          try { chrome.tabs.remove(tabId); } catch (e) { /* already gone */ }
        }
        action();
      }

      function consider(url) {
        if (!url || !String(url).startsWith(redirectPrefix)) return;
        finish(() => resolve(url));
      }

      function onUpdated(id, changeInfo, tab) {
        if (id !== tabId) return;
        consider(changeInfo.url || (tab && tab.url));
      }

      function onRemoved(id) {
        if (id === tabId) fail('The sign-in tab was closed before it finished.');
      }

      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);

      // A failed navigation does not always produce an onUpdated carrying the
      // URL, so the tab is also read directly as a backstop.
      const poll = setInterval(() => {
        if (tabId == null) return;
        try {
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) return;
            if (tab) consider(tab.pendingUrl || tab.url);
          });
        } catch (e) { /* the tab went away */ }
      }, 400);

      const timer = setTimeout(() => fail('Sign-in was not completed in time.'), 5 * 60 * 1000);

      try {
        chrome.tabs.create({ url: authUrl, active: true }, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            fail(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Could not open the sign-in tab.');
            return;
          }
          tabId = tab.id;
        });
      } catch (e) {
        fail(e.message);
      }
    });
  }

  // The response arrives in the query string (code flow) or the fragment
  // (implicit flow), so both are parsed and merged.
  function paramsFrom(redirect) {
    const url = new URL(redirect);
    const merged = new URLSearchParams(url.search);
    new URLSearchParams(url.hash.replace(/^#/, '')).forEach((v, k) => merged.set(k, v));
    return merged;
  }

  // ── Twitch ──────────────────────────────────────────────────────────────────

  async function connectTwitch(settings) {
    const clientId = (settings.twitchClientId || FCM.DEFAULT_TWITCH_CLIENT_ID).trim();
    if (!clientId) throw new Error('No Twitch client id is configured.');

    const state = base64url(crypto.getRandomValues(new Uint8Array(12)));
    const url = `${FCM.TWITCH_AUTH_URL}?client_id=${encodeURIComponent(clientId)}`
      + `&redirect_uri=${encodeURIComponent(redirectUri())}`
      + '&response_type=token'
      + `&scope=${encodeURIComponent(FCM.TWITCH_SCOPES)}`
      + `&state=${state}`
      + '&force_verify=true';

    const params = paramsFrom(await launch(url));
    if (params.get('error')) {
      throw new Error(String(params.get('error_description') || params.get('error')).replace(/\+/g, ' '));
    }
    if (params.get('state') !== state) {
      throw new Error('Sign-in response did not match the request.');
    }
    const accessToken = params.get('access_token');
    if (!accessToken) throw new Error('Twitch did not return a token.');

    // Validate immediately: it names the account and confirms the scopes.
    const who = await FCM.getJson(FCM.TWITCH_VALIDATE_URL, {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    if (!who || !who.user_id) throw new Error('Twitch rejected the new token.');

    await FCM.auth.set('twitch', {
      accessToken,
      clientId,
      userId: who.user_id,
      login: who.login || '',
      scopes: who.scopes || [],
      expiresAt: who.expires_in ? Date.now() + who.expires_in * 1000 : 0,
    });
    return { platform: 'twitch', login: who.login || '' };
  }

  // ── Kick ────────────────────────────────────────────────────────────────────

  function proxy(settings, path) {
    const base = String(settings.kickProxyUrl || FCM.DEFAULT_KICK_PROXY_URL).replace(/\/$/, '');
    return `${base}${path}`;
  }

  // The proxy is the authority: whichever application its client secret belongs
  // to is the one the token exchange will work for. The built-in id is only a
  // fallback for a transient failure of that one call.
  async function kickClientId(settings) {
    const data = await FCM.getJson(proxy(settings, '/kick-config'));
    if (data && data.client_id) return data.client_id;
    return FCM.DEFAULT_KICK_CLIENT_ID || '';
  }

  // Base64url without padding, for putting the extension's own redirect inside
  // the state parameter when the worker is bridging the callback.
  function base64urlText(text) {
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Where Kick is told to send the user back to.
   *
   * Going straight back to the extension is one hop fewer, but that URL carries
   * the extension's id, so it has to be registered with Kick — and registered
   * again if the id ever changes. Routing through the worker's callback instead
   * means the URL registered with Kick is fixed forever; the worker reads the
   * extension's own redirect out of the state parameter and forwards there.
   */
  function kickRedirect(settings) {
    const mode = settings.kickRedirect || 'shared';
    if (mode === 'proxy') {
      return { redirect: proxy(settings, '/kick-callback'), viaProxy: true, viaTab: false };
    }
    if (mode === 'extension') {
      return { redirect: redirectUri(), viaProxy: false, viaTab: false };
    }
    // 'shared': the redirect the desktop app already has registered, so there
    // is nothing for the user to set up. chrome.identity cannot finish on that
    // address, so the tab is watched instead.
    return { redirect: FCM.KICK_SHARED_REDIRECT, viaProxy: false, viaTab: true };
  }

  async function connectKick(settings) {
    const clientId = await kickClientId(settings);
    if (!clientId) {
      throw new Error('Could not reach the Kick proxy — check its URL in the extension options.');
    }

    const { verifier, challenge } = await generatePkce();
    const { redirect, viaProxy, viaTab } = kickRedirect(settings);
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(12)));
    // The worker needs to know where to hand control back to, and state is the
    // one parameter OAuth guarantees will come back untouched.
    const state = viaProxy ? `${nonce}~${base64urlText(redirectUri())}` : nonce;

    const url = `${FCM.KICK_AUTH_URL}?response_type=code`
      + `&client_id=${encodeURIComponent(clientId)}`
      + `&redirect_uri=${encodeURIComponent(redirect)}`
      + `&scope=${encodeURIComponent(FCM.KICK_SCOPES)}`
      + `&code_challenge=${challenge}&code_challenge_method=S256`
      + `&state=${encodeURIComponent(state)}`;

    const landed = viaTab ? await launchViaTab(url, redirect) : await launch(url);
    const params = paramsFrom(landed);
    if (params.get('error')) {
      throw new Error(String(params.get('error_description') || params.get('error')).replace(/\+/g, ' '));
    }
    if (params.get('state') !== state) {
      throw new Error('Sign-in response did not match the request.');
    }
    const code = params.get('code');
    if (!code) throw new Error('Kick did not return an authorization code.');

    const res = await fetch(proxy(settings, '/kick-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Must be the same redirect that was sent to the authorize step, or Kick
      // rejects the exchange.
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirect }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const detail = data.error || 'Kick refused the token exchange.';
      throw new Error(data.hint ? `${detail} — ${data.hint}` : detail);
    }

    const record = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresAt: Date.now() + ((data.expires_in || 3600) * 1000),
      login: '',
      userId: '',
    };
    await FCM.auth.set('kick', record);

    // Name the account so the UI can show who is connected.
    const me = await FCM.getJson(`${FCM.KICK_API}/users`, {
      headers: { Authorization: `Bearer ${record.accessToken}` },
    });
    const user = me && Array.isArray(me.data) ? me.data[0] : null;
    if (user) {
      record.login = user.name || user.username || '';
      record.userId = String(user.user_id || user.id || '');
      await FCM.auth.set('kick', record);
    }
    return { platform: 'kick', login: record.login };
  }

  async function refreshKick(settings, record) {
    if (!record.refreshToken) return null;
    const res = await fetch(proxy(settings, '/kick-refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: record.refreshToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) return null;
    const next = {
      ...record,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || record.refreshToken,
      expiresAt: Date.now() + ((data.expires_in || 3600) * 1000),
    };
    await FCM.auth.set('kick', next);
    return next;
  }

  /**
   * Returns a usable token record, refreshing it first if it is about to expire.
   * Kick can refresh silently; a Twitch implicit token cannot, so an expired one
   * is dropped and the caller is told to reconnect.
   */
  FCM.auth.usable = async function (platform, settings) {
    const record = await FCM.auth.get(platform);
    if (!record || !record.accessToken) return null;

    const nearlyExpired = record.expiresAt && record.expiresAt - Date.now() < 60 * 1000;
    if (!nearlyExpired) return record;

    if (platform === 'kick') {
      const refreshed = await refreshKick(settings, record);
      if (refreshed) return refreshed;
    }
    await FCM.auth.clear(platform);
    return null;
  };

  FCM.auth.connect = async function (platform, settings) {
    if (platform === 'twitch') return connectTwitch(settings);
    if (platform === 'kick') return connectKick(settings);
    throw new Error(`Cannot connect an account for ${platform}.`);
  };
})(self.FCM);
