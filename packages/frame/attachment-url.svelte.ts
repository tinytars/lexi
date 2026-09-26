// An attachment's URL, which the host app may have to produce asynchronously.
//
// Widened from a plain string return when a host began storing attachments as ciphertext: the URL
// is then a `blob:` URL minted after a fetch and a decrypt, which cannot be produced during render.
// A host that serves attachments directly still returns a string and is unaffected.
export type AttachmentUrl = (clientId: string, key: string) => string | Promise<string>;

/**
 * One `src`/`href` binding whose URL may arrive a tick after the element does.
 *
 * `current` is `undefined` until it does — and stays `undefined` if it never does, which is why
 * `error` exists: producing the URL can fail (a decrypt with no key, an expired session), the
 * effect re-runs only when `source()` changes, so nothing would retry and a consumer reading
 * `current` alone cannot tell a pending URL from a dead one. A binding that renders "nothing yet"
 * forever is how a broken download link looked like a slow one.
 *
 * Revocation belongs to the host: it minted the URL and is the only side that knows whether
 * anything else still holds it.
 */
export function resolveAttachmentUrl(source: () => { url: AttachmentUrl; clientId: string | null; key: string | null }) {
  let resolved = $state<string | undefined>();
  let failure = $state<string | undefined>();
  $effect(() => {
    const { url, clientId, key } = source();
    resolved = undefined;
    failure = undefined;
    if (!clientId || !key) return;
    let live = true;
    void Promise.resolve(url(clientId, key)).then(
      (u) => {
        if (live) resolved = u;
      },
      (e) => {
        if (live) failure = e instanceof Error ? e.message : "Couldn't open this attachment.";
      },
    );
    return () => {
      live = false;
    };
  });
  return {
    get current() {
      return resolved;
    },
    get error() {
      return failure;
    },
  };
}

/**
 * A URL, or a thunk producing one.
 *
 * The thunk form exists for surfaces that defer the work: a thumbnail that only loads when it
 * scrolls into view must not make the host fetch and decrypt the file to hand over a URL first.
 */
export type LazyUrl = string | (() => string | Promise<string>);

export const resolveLazyUrl = (url: LazyUrl): string | Promise<string> => (typeof url === "function" ? url() : url);
