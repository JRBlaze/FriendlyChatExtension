// Links to clips, found in what somebody typed.
//
// A clip link is the one kind of link a chat sees a lot of and nobody can
// judge from its text: a Twitch slug is four random words and a Kick id is a
// string of letters, so "look at this" with a bare address under it says
// nothing about what is on the other side. The feed asks the platform for the
// title and thumbnail and draws them under the row. This is the half that
// decides which links are worth asking about; the asking is in the worker.
(function (FCM) {
  'use strict';

  // The punctuation a link gets wrapped in when it is written into a sentence.
  const LEAD = /^[([{<"']+/;
  const TRAIL = /[.,!?;:'")\]}>]+$/;

  // Everything Twitch's share button and address bar produce for a clip, with
  // or without the scheme, www. or m.:
  //   clips.twitch.tv/<slug>
  //   clips.twitch.tv/embed?clip=<slug>
  //   twitch.tv/<channel>/clip/<slug>
  // A slug is letters, digits, hyphens and underscores. What follows it — a
  // query, a fragment — is Twitch's own tracking and not part of the id. The
  // embed form is tried first, or "embed" would be read as the slug.
  const TWITCH = [
    /^(?:https?:\/\/)?(?:(?:www|m)\.)?clips\.twitch\.tv\/embed\?(?:[^#]*&)?clip=([A-Za-z0-9_-]+)/i,
    /^(?:https?:\/\/)?(?:(?:www|m)\.)?clips\.twitch\.tv\/([A-Za-z0-9_-]+)(?:[?#]|$)/i,
    /^(?:https?:\/\/)?(?:(?:www|m)\.)?twitch\.tv\/[A-Za-z0-9_]+\/clip\/([A-Za-z0-9_-]+)(?:[?#]|$)/i,
  ];

  // Kick's two: the clip's own page, and the channel page with the clip opened
  // over it, which is what its share button copies.
  //   kick.com/<channel>/clips/clip_<id>
  //   kick.com/<channel>?clip=clip_<id>
  const KICK = [
    /^(?:https?:\/\/)?(?:www\.)?kick\.com\/([A-Za-z0-9_-]+)\/clips\/(clip_[A-Za-z0-9]+)(?:[?#]|$)/i,
    /^(?:https?:\/\/)?(?:www\.)?kick\.com\/([A-Za-z0-9_-]+)\/?\?(?:[^#]*&)?clip=(clip_[A-Za-z0-9]+)/i,
  ];

  // More than this in one message is a list, not a share, and a list of cards
  // would push the next message off the screen.
  const PER_MESSAGE = 3;

  function clipFor(word) {
    for (let i = 0; i < TWITCH.length; i += 1) {
      const m = TWITCH[i].exec(word);
      if (m) {
        return { platform: 'twitch', id: m[1], url: `https://clips.twitch.tv/${m[1]}` };
      }
    }
    for (let i = 0; i < KICK.length; i += 1) {
      const m = KICK[i].exec(word);
      if (m) {
        return {
          platform: 'kick',
          id: m[2],
          url: `https://kick.com/${m[1].toLowerCase()}/clips/${m[2]}`,
        };
      }
    }
    return null;
  }

  /**
   * The clips linked in a message, in the order they were written, each once.
   *
   * The address given back is the clip's canonical page rather than whatever
   * was typed, so the card opens the clip and not, say, the channel page with
   * a tracking query on it.
   *
   * @returns {{platform: string, id: string, url: string}[]}
   */
  FCM.findClipLinks = function (text) {
    const out = [];
    const seen = new Set();
    String(text || '').split(/\s+/).forEach((raw) => {
      if (out.length >= PER_MESSAGE) return;
      const word = raw.replace(LEAD, '').replace(TRAIL, '');
      if (!word || word.indexOf('.') === -1) return;
      const clip = clipFor(word);
      if (!clip) return;
      const key = `${clip.platform}:${clip.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(clip);
    });
    return out;
  };
})(self.FCM);
