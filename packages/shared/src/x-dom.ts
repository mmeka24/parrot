/**
 * THE DOM CONTRACT for the Parrot browser extension.
 *
 * These are the `data-testid` hooks x.com puts on its own markup. The extension
 * reads posts through this map and nothing else, and the local stand-in
 * (apps/x-clone) emits the same hooks - so the one content script runs on both
 * without a branch.
 *
 * What that does and does not prove: the extension has been exercised against
 * the clone only. The names below were taken from x.com's markup, but x.com
 * changes them without notice and the extension has never been run there. Any
 * claim that it "works on X" needs a live check first; this file is where the
 * fix goes if a name has moved.
 */

export const X_TESTID = {
  /** One post. An <article>. */
  tweet: 'tweet',
  /** Display name, @handle and the timestamp permalink. */
  userName: 'User-Name',
  /** The post body. */
  tweetText: 'tweetText',
  /** Wraps the <video>. */
  videoPlayer: 'videoPlayer',
  /** The inner video wrapper on x.com; a second hook for the same thing. */
  videoComponent: 'videoComponent',
  reply: 'reply',
  retweet: 'retweet',
  like: 'like',
  unlike: 'unlike',
  /** The composer's text box, in the reply dialog and inline. */
  composerInput: 'tweetTextarea_0',
  /** Submit, inside the reply dialog. */
  composerSubmit: 'tweetButton',
  /** Submit, on the inline composer. */
  composerSubmitInline: 'tweetButtonInline',
  /** The signed-in account chip in the side nav; contains "@handle". */
  accountSwitcher: 'SideNav_AccountSwitcher_Button',
  /** The side nav's Profile link, href "/{handle}". */
  profileLink: 'AppTabBar_Profile_Link',
  primaryColumn: 'primaryColumn',
} as const;

export type XTestId = (typeof X_TESTID)[keyof typeof X_TESTID];

/** CSS selector for one hook. */
export function xSelector(id: XTestId): string {
  return `[data-testid="${id}"]`;
}

/** Permalinks look like /{handle}/status/{id} on both surfaces. */
export const X_STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/([A-Za-z0-9_-]+)/;

/** Pull `{handle, postId}` out of a permalink href (absolute or relative). */
export function parseStatusHref(href: string): { handle: string; postId: string } | null {
  let path: string;
  try {
    path = new URL(href, 'https://x.invalid').pathname;
  } catch {
    return null;
  }
  const match = X_STATUS_PATH.exec(path);
  if (!match || !match[1] || !match[2]) return null;
  return { handle: match[1].toLowerCase(), postId: match[2] };
}

/** Whether a piece of text addresses the bot, e.g. "@parrot dub this". */
export function mentionsHandle(text: string, handle: string): boolean {
  const clean = handle.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
  if (clean === '') return false;
  return new RegExp(`(^|[^A-Za-z0-9_])@${clean}(?![A-Za-z0-9_])`, 'i').test(text);
}
