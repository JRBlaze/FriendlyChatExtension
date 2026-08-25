// The only part of this extension that runs in the page's own world.
//
// Everything else lives in the isolated world, where `window` belongs to the
// extension and the page cannot reach it. Two things are not reachable from
// there, and both of them are Twitch's:
//
//   - When someone started following a channel. Twitch's public API answers
//     this only for the broadcaster and their moderators; Twitch's own site
//     shows it to any signed-in viewer, because the site asks its own GraphQL
//     as that viewer. This borrows the site's own client to ask the same way.
//   - Gifting a subscription. There is no API for it at all — spending money
//     goes through Twitch's own checkout, which is a React prop on Twitch's own
//     components. This finds that prop and calls it, so Twitch's dialog opens
//     and Twitch takes the payment. Nothing here ever handles money.
//
// Nothing on the page is modified, patched or shadowed. It reads two things and
// calls one function that already exists.
//
// SECURITY. `window.postMessage` is readable and writable by the page and by
// every other extension sharing this world. The handle passed on each request
// is echoed back so replies can be matched to the bridge that asked; it stops
// crosstalk between two bridges and between extensions, and it is NOT a secret
// — anything in this world can read it off a request and forge a reply.
//
// So the protection is not the handle, it is what the answers are allowed to do:
// they are bounded, escaped and rendered as text in a menu, and never reach a
// send, a moderation action, a stored setting or an auth flow. Nothing secret
// is ever sent in this direction either. The worst a hostile page can achieve
// is a wrong date in a menu, or opening Twitch's own gift dialog — which the
// viewer still has to complete themselves, in Twitch's own checkout.
(function () {
  'use strict';

  const INBOUND = 'fcm-page-request';
  const OUTBOUND = 'fcm-page-reply';
  // How far into the fiber tree to look before giving up. The Apollo provider
  // sits within a handful of nodes of the root; a bound stops a page that has
  // changed shape from turning this into an unbounded walk on every call.
  const MAX_FIBER_STEPS = 40000;
  // The prop names Twitch has used for "open the subscription checkout". More
  // than one because Twitch renames them, and a list costs nothing.
  const CHECKOUT_PROPS = [
    'onShowSubscriptionCheckout', 'showSubscriptionCheckout',
    'openSubscriptionCheckout', 'showCheckoutModal', 'showSubscriptionModal',
  ];

  // ── React ───────────────────────────────────────────────────────────────────

  function rootFiber() {
    const root = document.querySelector('#root') || document.body;
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith('__reactContainer')
      || k.startsWith('__reactFiber'));
    return key ? root[key] : null;
  }

  /**
   * Walks the fiber tree until `pick` returns something.
   *
   * Depth-first over child and sibling, which is the whole tree, bounded by a
   * step count. Returns whatever `pick` found, or null.
   */
  function searchFibers(pick) {
    const start = rootFiber();
    if (!start) return null;
    const stack = [start];
    let steps = 0;
    while (stack.length && steps < MAX_FIBER_STEPS) {
      const fiber = stack.pop();
      steps++;
      if (!fiber) continue;
      let hit = null;
      try { hit = pick(fiber); } catch (e) { hit = null; }
      if (hit) return hit;
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return null;
  }

  // Held between calls because the walk is the expensive part, and dropped the
  // moment it stops working — Twitch replaces its tree on navigation.
  let cachedClient = null;

  function apolloClient() {
    if (cachedClient && typeof cachedClient.query === 'function') return cachedClient;
    cachedClient = searchFibers((fiber) => {
      const props = fiber.memoizedProps;
      if (props && props.client && typeof props.client.query === 'function') return props.client;
      return null;
    });
    return cachedClient;
  }

  // ── GraphQL ─────────────────────────────────────────────────────────────────

  // Apollo wants a parsed document rather than a string, and the page does not
  // hand out its parser. Building the handful of nodes this one query needs is
  // smaller than carrying a parser, and it cannot drift: the shape is fixed
  // here rather than assembled from text at runtime.
  const name = (value) => ({ kind: 'Name', value });
  const variable = (value) => ({ kind: 'Variable', name: name(value) });
  const selections = (list) => ({ kind: 'SelectionSet', selections: list });

  function field(fieldName, opts) {
    const options = opts || {};
    const node = { kind: 'Field', name: name(fieldName), arguments: [] };
    if (options.alias) node.alias = name(options.alias);
    (options.args || []).forEach((arg) => {
      node.arguments.push({
        kind: 'Argument',
        name: name(arg.name),
        value: arg.enum
          ? { kind: 'EnumValue', value: arg.enum }
          : variable(arg.variable),
      });
    });
    if (options.sels) node.selectionSet = selections(options.sels);
    return node;
  }

  const RELATIONSHIP_QUERY = {
    kind: 'Document',
    definitions: [{
      kind: 'OperationDefinition',
      operation: 'query',
      name: name('FCMViewerRelationship'),
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: variable('login'),
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: name('String') } },
        },
        {
          kind: 'VariableDefinition',
          variable: variable('channelID'),
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: name('ID') } },
        },
      ],
      selectionSet: selections([
        field('user', {
          args: [{ name: 'login', variable: 'login' }],
          sels: [
            field('id'),
            field('login'),
            field('displayName'),
            field('createdAt'),
            field('relationship', {
              args: [{ name: 'targetUserID', variable: 'channelID' }],
              sels: [
                field('followedAt'),
                field('subscriptionBenefit', { sels: [field('tier')] }),
                field('subscriptionTenure', {
                  alias: 'cumulativeTenure',
                  args: [{ name: 'tenureMethod', enum: 'CUMULATIVE' }],
                  sels: [field('months')],
                }),
              ],
            }),
          ],
        }),
      ]),
    }],
  };

  async function relationship(payload) {
    const client = apolloClient();
    if (!client) throw new Error('no-client');
    const login = String(payload.login || '').toLowerCase();
    const channelID = String(payload.channelId || '');
    if (!login || !channelID) throw new Error('bad-request');

    let res;
    try {
      res = await client.query({
        query: RELATIONSHIP_QUERY,
        variables: { login, channelID },
        // Twitch's own cache would answer for a viewer whose card it has
        // already drawn, which is exactly what should happen.
        fetchPolicy: 'cache-first',
        errorPolicy: 'all',
      });
    } catch (e) {
      // A client that has stopped working is worth forgetting, so the next call
      // goes looking for the current one.
      cachedClient = null;
      throw new Error('query-failed');
    }

    const user = res && res.data && res.data.user;
    if (!user) throw new Error('not-found');
    const rel = user.relationship || null;
    const tenure = rel && rel.cumulativeTenure;
    const benefit = rel && rel.subscriptionBenefit;
    return {
      login: user.login || login,
      displayName: user.displayName || '',
      createdAt: user.createdAt || '',
      followedAt: (rel && rel.followedAt) || '',
      // Twitch's tiers are 1000/2000/3000; the overlay shows 1/2/3.
      subscriptionTier: (benefit && benefit.tier) || '',
      subscriptionMonths: (tenure && Number(tenure.months)) || 0,
    };
  }

  // ── Gifting ─────────────────────────────────────────────────────────────────

  function checkoutHandler() {
    return searchFibers((fiber) => {
      const props = fiber.memoizedProps;
      if (!props) return null;
      for (const key of CHECKOUT_PROPS) {
        if (typeof props[key] === 'function') return props[key];
      }
      return null;
    });
  }

  /**
   * Opens Twitch's own gift-subscription checkout for a viewer.
   *
   * This opens a dialog. It does not buy anything: Twitch draws its own
   * checkout, with its own price and its own confirm button, and the viewer
   * completes it there or closes it. Nothing in this extension sees a payment
   * method, and nothing here can complete a purchase.
   */
  function giftSub(payload) {
    const tier = ['1000', '2000', '3000'].indexOf(String(payload.tier)) === -1
      ? '1000' : String(payload.tier);
    const recipient = String(payload.recipient || '').toLowerCase();
    if (!recipient) throw new Error('bad-request');
    const open = checkoutHandler();
    if (!open) throw new Error('no-checkout');
    open({
      action: 'buy_gift_sub',
      checkoutButtonTier: tier,
      giftRecipient: recipient,
      multiMonthGiftAmount: 1,
      isAnonymous: false,
    });
    return { opened: true, tier };
  }

  // Whether the parts this depends on are present, so the overlay can offer
  // only what actually works rather than buttons that do nothing.
  function capabilities() {
    return {
      relationship: !!apolloClient(),
      gifting: !!checkoutHandler(),
    };
  }

  const OPS = { relationship, giftSub, capabilities };

  // ── Bridge ──────────────────────────────────────────────────────────────────

  window.addEventListener('message', async (event) => {
    // Only messages this window posted to itself, from this document's origin.
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.channel !== INBOUND || typeof msg.id !== 'string') return;

    // The handle is echoed back rather than remembered. Latching onto the first
    // one seen was wrong: the overlay is rebuilt on every channel change, and a
    // second bridge with a fresh handle was then ignored for the life of the
    // page, which is a hang rather than a refusal.
    if (typeof msg.nonce !== 'string' || !msg.nonce) return;
    const reply = { channel: OUTBOUND, nonce: msg.nonce, id: msg.id };

    const op = OPS[msg.op];
    if (!op) {
      window.postMessage({ ...reply, ok: false, error: 'unknown-op' }, location.origin);
      return;
    }
    try {
      const data = await op(msg.args || {});
      window.postMessage({ ...reply, ok: true, data }, location.origin);
    } catch (e) {
      window.postMessage({
        ...reply, ok: false, error: String((e && e.message) || 'failed').slice(0, 60),
      }, location.origin);
    }
  });
})();
