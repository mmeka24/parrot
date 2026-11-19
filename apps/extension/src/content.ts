/**
 * The content script: Parrot, drawn onto the posts in a timeline.
 *
 * For every post on the page it asks the Parrot server what it knows, and adds
 * a small strip under the post:
 *
 *   - anyone:   "Also in  [Spanish] [Hindi]"   -> opens the dub page
 *   - anyone:   "Parrot is weighing it up..."  while a request is in progress
 *   - the author, on their own video:  [Dub this v]  -> pick a language
 *
 * "Dub this" does not call Parrot. It does what a creator would do by hand:
 * opens the reply box under their own post, types "@parrot dub this to
 * Spanish", and sends it. Parrot then finds that reply the way it finds any
 * mention, checks on its own records that the person asking really wrote the
 * post, and answers in the thread. The extension is a shortcut for the human,
 * never a side door into the agent.
 *
 * Posts are found through x.com's own markup hooks (@parrot/shared x-dom.ts).
 * The local stand-in emits the same hooks; real x.com has not been tried.
 */

import { copy, fill } from '@parrot/shared/copy';
import { X_TESTID, parseStatusHref, xSelector } from '@parrot/shared/x-dom';
import type {
  ExtensionConfigDto,
  ExtensionDubDto,
  ExtensionPostStatusDto,
} from '@parrot/shared';
import { ask } from './messages';
import { el, parrotMark, waitFor } from './dom';
import { STRIP_CSS } from './styles';

const t = copy.extension;

/** The marker on our own element, so a rescan finds it rather than adding a second. */
const HOST_ATTR = 'data-parrot-strip';

const POLL_IDLE_MS = 4_000;
const POLL_BUSY_MS = 1_200;

interface FoundPost {
  readonly article: HTMLElement;
  readonly postId: string;
}

/** What only this tab knows about a post: an open menu, an in-flight request. */
interface LocalState {
  menuOpen: boolean;
  busy: boolean;
  /** A request this tab just sent, until the server has seen it. */
  sentAt: number | null;
  message: { text: string; error: boolean } | null;
}

let config: ExtensionConfigDto | null = null;
const statuses = new Map<string, ExtensionPostStatusDto>();
const local = new Map<string, LocalState>();
/** The last thing drawn per strip, so an unchanged strip is left alone. */
const drawn = new WeakMap<ShadowRoot, string>();

let timer: number | null = null;

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

/** Every post on the page with an id we can read. */
function findPosts(): FoundPost[] {
  const found: FoundPost[] = [];
  for (const article of document.querySelectorAll<HTMLElement>(xSelector(X_TESTID.tweet))) {
    // A post nested inside another (a quote) belongs to its outer post.
    if (article.parentElement?.closest(xSelector(X_TESTID.tweet))) continue;
    const postId = permalinkOf(article);
    if (postId) found.push({ article, postId });
  }
  return found;
}

/**
 * A post's id, from its permalink. The timestamp link is the canonical one on
 * x.com; any /status/ link in the post is the fallback.
 */
function permalinkOf(article: HTMLElement): string | null {
  const anchors = [
    article.querySelector('a time')?.closest('a'),
    ...article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'),
  ];
  for (const anchor of anchors) {
    const href = anchor?.getAttribute('href');
    const parsed = href ? parseStatusHref(href) : null;
    if (parsed) return parsed.postId;
  }
  return null;
}

/** The signed-in handle, from the account chip in the side nav. */
function currentHandle(): string | null {
  const chip = document.querySelector(xSelector(X_TESTID.accountSwitcher));
  const match = chip?.textContent?.match(/@([A-Za-z0-9_]{1,15})/);
  return match?.[1]?.toLowerCase() ?? null;
}

function stateFor(postId: string): LocalState {
  let state = local.get(postId);
  if (!state) {
    state = { menuOpen: false, busy: false, sentAt: null, message: null };
    local.set(postId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;

  const posts = findPosts();
  if (posts.length > 0) {
    if (!config) {
      const response = await ask({ type: 'config' });
      if (response.ok) config = response.data;
    }
    if (config) {
      const ids = [...new Set(posts.map((p) => p.postId))];
      const response = await ask({ type: 'posts', ids });
      if (response.ok) {
        for (const status of response.data.posts) statuses.set(status.postId, status);
      }
    }
    drawAll();
  }

  const busy = [...local.values()].some((s) => s.busy || s.sentAt !== null) ||
    [...statuses.values()].some((s) => s.pending);
  timer = window.setTimeout(() => void refresh(), busy ? POLL_BUSY_MS : POLL_IDLE_MS);
}

/** Draw from what is already known. Cheap; runs on every page mutation. */
function drawAll(): void {
  const me = currentHandle();
  for (const { article, postId } of findPosts()) {
    const status = statuses.get(postId);
    const state = stateFor(postId);
    // A request this tab sent is settled once the server reports an answer
    // newer than it, or stops calling it pending after having seen it.
    if (state.sentAt !== null && status?.lastReply) {
      if (new Date(status.lastReply.at).getTime() >= state.sentAt - 2_000) {
        state.sentAt = null;
      }
    }
    if (state.sentAt !== null && Date.now() - state.sentAt > 30_000) state.sentAt = null;
    draw(article, postId, status, state, me);
  }
}

function scheduleSoon(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => void refresh(), 150);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function hostFor(article: HTMLElement): ShadowRoot {
  let host = article.querySelector<HTMLElement>(`[${HOST_ATTR}]`);
  if (!host || !host.shadowRoot) {
    host = el('div', { [HOST_ATTR]: '' });
    // The page must not treat a click on the strip as a click on the post
    // (which would open the thread). Inside a shadow root the page sees the
    // host as the target, so the one place to stop that is here.
    for (const type of ['click', 'mousedown', 'pointerdown', 'keydown']) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    const root = host.attachShadow({ mode: 'open' });
    root.append(el('style', {}, [STRIP_CSS]));
    // Under the action bar if there is one, as the last thing in the post.
    const actions = article.querySelector('[role="group"]');
    if (actions?.parentElement) actions.after(host);
    else article.append(host);
  }
  return host.shadowRoot as ShadowRoot;
}

function removeStrip(article: HTMLElement): void {
  article.querySelector(`[${HOST_ATTR}]`)?.remove();
}

function draw(
  article: HTMLElement,
  postId: string,
  status: ExtensionPostStatusDto | undefined,
  state: LocalState,
  me: string | null,
): void {
  if (!config || !status || !status.known) return removeStrip(article);

  const isAuthor = me !== null && status.authorHandle === me;
  const watchable = status.dubs.filter((d) => d.watchable);
  const pending = status.pending || state.sentAt !== null || state.busy;
  const canDub = isAuthor && status.hasVideo;

  if (watchable.length === 0 && !pending && !canDub && !state.message) {
    return removeStrip(article);
  }

  // Skip the redraw when nothing visible changed, so focus and hover survive
  // the poll.
  const signature = JSON.stringify([
    watchable.map((d) => d.jobId),
    pending,
    canDub,
    state.menuOpen,
    state.busy,
    state.message,
    isAuthor ? status.lastReply : null,
    status.dubs.map((d) => d.languageCode),
  ]);
  const root = hostFor(article);
  if (drawn.get(root) === signature) return;
  drawn.set(root, signature);

  const strip = el('div', { class: 'strip' });
  const row = el('div', { class: 'row' }, [
    el('span', { class: 'brand' }, [parrotMark(16), t.name]),
  ]);

  if (watchable.length > 0) {
    row.append(el('span', { class: 'label' }, [t.watchPrefix]));
    for (const dub of watchable) row.append(watchChip(dub));
  }

  if (pending) {
    row.append(
      el('span', { class: 'pending', role: 'status' }, [
        el('span', { class: 'dot' }),
        state.busy ? t.typing : t.pending,
      ]),
    );
  }

  if (canDub) {
    row.append(el('span', { class: 'spacer' }));
    const button = el(
      'button',
      {
        type: 'button',
        class: 'cta',
        'aria-haspopup': 'true',
        'aria-expanded': state.menuOpen ? 'true' : 'false',
        disabled: state.busy,
      },
      [status.dubs.length > 0 ? t.dubCtaAnother : t.dubCta, el('span', { class: 'caret' })],
    );
    button.addEventListener('click', () => {
      state.menuOpen = !state.menuOpen;
      state.message = null;
      drawAll();
    });
    row.append(button);
  }

  strip.append(row);

  if (canDub && state.menuOpen && !state.busy) strip.append(languageMenu(article, postId, status, state));

  if (state.message) {
    strip.append(
      el('p', { class: `status${state.message.error ? ' error' : ''}`, role: 'status' }, [
        state.message.text,
      ]),
    );
  } else if (isAuthor && status.lastReply && !pending) {
    strip.append(el('p', { class: 'reply' }, [el('b', {}, [`${t.replyPrefix}: `]), status.lastReply.text]));
  }

  // Keep the stylesheet, replace the rest.
  root.querySelector('.strip')?.remove();
  root.append(strip);
}

function watchChip(dub: ExtensionDubDto): HTMLAnchorElement {
  return el(
    'a',
    {
      class: 'chip',
      href: dub.watchUrl ?? '#',
      target: '_blank',
      rel: 'noopener',
      title: fill(t.watchChipTitle, {
        language: dub.languageName,
        price: config?.unlockPrice.display ?? '',
      }),
    },
    [el('span', { class: 'tri' }), dub.languageName],
  );
}

function languageMenu(
  article: HTMLElement,
  postId: string,
  status: ExtensionPostStatusDto,
  state: LocalState,
): HTMLElement {
  // One dub per (video, language): anything already asked for is answered
  // with the existing result, so it is not offered again.
  const taken = new Set(status.dubs.map((d) => d.languageCode));
  const open = (config?.languages ?? []).filter((l) => !taken.has(l.code));

  const menu = el('div', { class: 'menu', role: 'menu', 'aria-label': t.menuTitle });
  menu.append(el('p', { class: 'menu-title' }, [t.menuTitle]));

  if (open.length === 0) {
    menu.append(el('p', { class: 'note' }, [t.menuEmpty]));
    return menu;
  }

  const langs = el('div', { class: 'langs' });
  for (const language of open) {
    const item = el('button', { type: 'button', class: 'lang', role: 'menuitem' }, [
      language.englishName,
    ]);
    item.addEventListener('click', () => void requestDub(article, postId, language.englishName, state));
    langs.append(item);
  }
  menu.append(langs);
  menu.append(
    el('p', { class: 'note' }, [
      fill(t.menuNote, { creatorPercent: config?.creatorPercent ?? 60 }),
    ]),
  );
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      state.menuOpen = false;
      drawAll();
    }
  });
  return menu;
}

// ---------------------------------------------------------------------------
// Asking for a dub: the creator's own reply, typed for them
// ---------------------------------------------------------------------------

async function requestDub(
  article: HTMLElement,
  postId: string,
  languageName: string,
  state: LocalState,
): Promise<void> {
  if (!config) return;
  const request = fill(config.requestTemplate, {
    handle: config.botHandle,
    language: languageName,
  });

  state.menuOpen = false;
  state.busy = true;
  state.message = null;
  drawAll();

  const sent = await replyUnder(article, request);

  state.busy = false;
  if (sent) {
    state.sentAt = Date.now();
  } else {
    state.message = { text: fill(t.composerFailed, { request }), error: true };
  }
  drawAll();
  scheduleSoon();
}

/**
 * Open the post's reply box, type `text`, send it. Returns false if any step
 * did not happen - the caller then tells the person what to type themselves.
 */
async function replyUnder(article: HTMLElement, text: string): Promise<boolean> {
  const replyButton = article.querySelector<HTMLElement>(xSelector(X_TESTID.reply));
  if (!replyButton) return false;
  replyButton.click();

  // The reply DIALOG's composer, specifically. A thread page also has an
  // inline composer with the same hook, and it is already on the page before
  // the dialog renders - taking the first match would type into the wrong box
  // and leave the dialog open and empty.
  const dialogInput = await waitFor(
    () => document.querySelector<HTMLElement>(`[role="dialog"] ${xSelector(X_TESTID.composerInput)}`),
    2_000,
  );
  const input = dialogInput ?? document.querySelector<HTMLElement>(xSelector(X_TESTID.composerInput));
  if (!input) return false;

  typeInto(input, text);

  const scope = submitScope(input);
  const submit = await waitFor(() => {
    const button = scope.querySelector<HTMLButtonElement>(SUBMIT_SELECTOR);
    if (!button) return null;
    const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
    return disabled ? null : button;
  }, 3_000);
  if (!submit) return false;
  submit.click();

  // Sent once the composer has gone (dialog) or emptied (inline).
  const done = await waitFor(
    () => !input.isConnected || readText(input).trim() === '',
    8_000,
  );
  return done !== null;
}

const SUBMIT_SELECTOR = `${xSelector(X_TESTID.composerSubmit)}, ${xSelector(X_TESTID.composerSubmitInline)}`;

/**
 * The submit button that belongs to THIS composer: the dialog's, or else the
 * nearest one above the input. Never a page-wide first match, which on a
 * thread page with the dialog open would be the other composer's button.
 */
function submitScope(input: HTMLElement): ParentNode {
  const dialog = input.closest('[role="dialog"]');
  if (dialog) return dialog;
  let node: HTMLElement | null = input.parentElement;
  while (node && !node.querySelector(SUBMIT_SELECTOR)) node = node.parentElement;
  return node ?? document;
}

/**
 * Put text into the page's composer so the PAGE notices. Setting `.value`
 * directly is invisible to a framework that tracks the field itself, so the
 * value goes in through the native setter and an input event follows - the
 * same thing a keystroke produces. A rich-text composer (x.com's) takes it as
 * an insertText edit instead.
 */
function typeInto(input: HTMLElement, text: string): void {
  input.focus();
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const editable = input.isContentEditable
    ? input
    : input.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!editable) return;
  editable.focus();
  // Deprecated, and still the only edit a rich-text editor accepts as typing.
  document.execCommand('insertText', false, text);
}

function readText(input: HTMLElement): string {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) return input.value;
  return input.textContent ?? '';
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function start(): void {
  // New posts (scrolling, navigation, a fresh reply) get drawn from what is
  // known at once, and fetched for if they are new.
  const observer = new MutationObserver((mutations) => {
    const ours = mutations.every((m) =>
      m.target instanceof Element && m.target.closest(`[${HOST_ATTR}]`) !== null,
    );
    if (ours) return;
    const unseen = findPosts().some((p) => !statuses.has(p.postId));
    drawAll();
    if (unseen) scheduleSoon();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Coming back to the tab is when a result someone was waiting for shows up.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSoon();
  });

  void refresh();
}

start();
