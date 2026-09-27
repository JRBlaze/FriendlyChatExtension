// Only the marked Firefox sender constructs this helper. Permission belongs to
// YouTube on the embedding site; no cookies or credentials are read or copied.
(function (FCM) {
  'use strict';
  FCM.createYouTubeAccess = function ({ document, onState, onReload, onClose, isCurrent, canRestore }) {
    let destroyed = false, panel = null, revision = 0, busy = false;
    function current() {
      try { return !destroyed && isCurrent(); } catch (_) { return false; }
    }
    function supported() {
      return typeof document.hasStorageAccess === 'function' && typeof document.requestStorageAccess === 'function';
    }
    function emit(value) { if (current()) onState(value); }
    async function restoreGrant(token) {
      const permissions = document.defaultView?.navigator?.permissions;
      if (!permissions?.query || !canRestore()) return false;
      try {
        const permission = await permissions.query({ name: 'storage-access' });
        if (!current() || token !== revision) return true;
        if (permission?.state !== 'granted' || !canRestore()) return false;
        // A previously approved site pair can be activated without another
        // prompt. Never request automatically for prompt/denied/unknown states.
        emit('requesting');
        await document.requestStorageAccess();
        if (current() && token === revision) { emit('granted'); onReload(); }
        return true;
      } catch (_) { return false; }
    }
    async function inspect() {
      if (!supported()) { emit('unsupported'); return; }
      const token = ++revision;
      try {
        const granted = await document.hasStorageAccess();
        if (token !== revision || !current()) return;
        if (granted === false && await restoreGrant(token)) return;
        if (token === revision) emit(granted === true ? 'granted' : granted === false ? 'needed' : 'unknown');
      } catch (_) { if (token === revision) emit('error'); }
    }
    function close() {
      revision++;
      busy = false;
      if (panel) { panel.remove(); panel = null; }
    }
    function open() {
      if (!current() || !supported()) return false;
      if (panel) return true;
      panel = document.createElement('div');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', 'Friendly Chat YouTube sign-in access');
      panel.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;box-sizing:border-box!important;padding:20px!important;background:#fff!important;color:#172034!important;font:15px/1.5 system-ui,sans-serif!important;overflow:auto!important;';
      const heading = document.createElement('h2');
      heading.textContent = 'Use YouTube sign-in here';
      heading.style.cssText = 'font-size:19px;margin:0 0 12px;';
      const note = document.createElement('p');
      note.textContent = 'Allow YouTube to use its sign-in cookies on this site. Firefox tracking protection stays on. Twitch and Kick need separate approval. This does not send a chat message.';
      note.setAttribute('role', 'status');
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.textContent = 'Allow YouTube sign-in';
      allow.style.cssText = 'padding:9px 12px;margin:8px 8px 0 0;background:#5a32a3;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer;';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.style.cssText = 'padding:9px 12px;margin-top:8px;background:#eee;color:#172034;border:1px solid #bbb;border-radius:6px;font:inherit;cursor:pointer;';
      const cancelSetup = event => {
        if (!event.isTrusted || !current() || !panel) return;
        close(); onClose();
      };
      cancel.addEventListener('click', cancelSetup);
      panel.addEventListener('keydown', event => { if (event.key === 'Escape') cancelSetup(event); });
      allow.addEventListener('click', async event => {
        if (!event.isTrusted || !current() || !panel || busy) return;
        busy = true;
        const token = ++revision;
        allow.disabled = true;
        note.textContent = 'Waiting for Firefox to allow YouTube sign-in on this site…';
        emit('requesting');
        try {
          // This call must happen in the actual iframe's trusted click handler,
          // before awaiting anything. A host-page message cannot grant access.
          await document.requestStorageAccess();
          if (!current() || !panel || token !== revision) return;
          note.textContent = 'Access allowed. Reconnecting YouTube sending…';
          emit('granted');
          onReload();
        } catch (error) {
          if (!current() || !panel || token !== revision) return;
          busy = false;
          allow.disabled = false;
          note.textContent = 'Access was not granted. Open YouTube in this Firefox profile and interact with the signed-in page, then try again. Firefox may also ask you to allow access. Reading chat can continue without it.';
          emit(error?.name === 'NotAllowedError' ? 'denied' : 'error');
        }
      });
      panel.append(heading, note, allow, cancel);
      (document.body || document.documentElement).appendChild(panel);
      allow.focus();
      return true;
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
    }
    void inspect();
    return { open, close, destroy };
  };
})(self.FCM);
