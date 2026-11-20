'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState, type MouseEvent } from 'react';
import { X_TESTID, type XPostDto } from '@parrot/shared';
import { engage } from '@/lib/api';
import { formatAge, formatCount, formatFull } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar } from './Avatar';
import { LikeIcon, ReplyIcon, RepostIcon, ViewsIcon } from './icons';
import { VideoPlayer } from './VideoPlayer';

/**
 * One post.
 *
 * The `data-testid` hooks are x.com's own names (see @parrot/shared x-dom.ts).
 * Chirp has no use for them itself; they are here so that a browser extension
 * written for x.com's markup finds the same landmarks on this page.
 */
export function PostCard({
  post,
  variant = 'timeline',
}: {
  post: XPostDto;
  variant?: 'timeline' | 'focus';
}) {
  const router = useRouter();
  const session = useSession();
  const [local, setLocal] = useState<XPostDto | null>(null);
  const shown = local && local.id === post.id ? { ...post, metrics: local.metrics } : post;

  const permalink = `/${post.author.handle}/status/${post.id}`;
  const liked = session.isMarked('like', post.id);
  const reposted = session.isMarked('repost', post.id);
  const focus = variant === 'focus';

  function openThread(event: MouseEvent<HTMLElement>): void {
    if (focus) return;
    // Anything interactive inside the card handles its own click - including
    // whatever a browser extension has added to it.
    const target = event.target as HTMLElement;
    if (target.closest('a, button, video, textarea, input, [role="menu"]')) return;
    if (window.getSelection()?.toString()) return;
    router.push(permalink);
  }

  function toggle(kind: 'like' | 'repost'): void {
    const on = !(kind === 'like' ? liked : reposted);
    session.setMarked(kind, post.id, on);
    engage(post.id, { kind, delta: on ? 1 : -1 })
      .then(setLocal)
      .catch(() => session.setMarked(kind, post.id, !on));
  }

  return (
    <article
      data-testid={X_TESTID.tweet}
      onClick={openThread}
      className={`border-b border-rule px-4 py-3 ${focus ? '' : 'cursor-pointer transition-colors hover:bg-hover'}`}
    >
      <div className={focus ? '' : 'flex gap-3'}>
        <div className={focus ? 'mb-3 flex items-center gap-3' : 'shrink-0'}>
          <Link href={`/${post.author.handle}`} aria-label={post.author.displayName}>
            <Avatar handle={post.author.handle} displayName={post.author.displayName} />
          </Link>
          {focus ? <Byline post={post} permalink={permalink} stacked /> : null}
        </div>

        <div className="min-w-0 flex-1">
          {focus ? null : <Byline post={post} permalink={permalink} />}

          {post.inReplyToHandle ? (
            <div className="text-dim">
              Replying to{' '}
              <Link href={`/${post.inReplyToHandle}`} className="text-accent hover:underline">
                @{post.inReplyToHandle}
              </Link>
            </div>
          ) : null}

          <div
            data-testid={X_TESTID.tweetText}
            lang={post.dub?.languageCode ?? 'en'}
            className={`whitespace-pre-wrap break-words ${focus ? 'text-[17px] leading-6' : ''}`}
          >
            <RichText text={post.text} />
          </div>

          {post.dub ? (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-rule-strong px-2.5 py-0.5 text-[13px] font-medium text-dim">
              <span aria-hidden="true">{post.dub.flag}</span>
              Dubbed into {post.dub.languageName}
              {post.dub.simulated ? ' · stand-in audio' : ''}
            </div>
          ) : null}

          {post.video ? (
            <VideoPlayer
              postId={post.id}
              durationS={post.video.durationS}
              url={post.video.url}
              placeholderLabel={
                post.dub ? `${post.dub.nativeName} dub · stand-in, nothing to play` : 'Sample clip · no footage'
              }
              onViewed={(views) => setLocal({ ...shown, metrics: { ...shown.metrics, views } })}
            />
          ) : null}

          {focus ? (
            <div className="mt-3 border-b border-rule pb-3 text-dim">
              <Link href={permalink} className="hover:underline">
                <time dateTime={post.createdAt}>{formatFull(post.createdAt)}</time>
              </Link>
              {shown.metrics.views !== null ? (
                <>
                  {' · '}
                  <span className="font-bold text-ink">{formatCount(shown.metrics.views)}</span>{' '}
                  Views
                </>
              ) : null}
            </div>
          ) : null}

          <div
            role="group"
            aria-label="Post actions"
            className={`tabular mt-2 flex max-w-[425px] items-center justify-between text-[13px] text-dim ${focus ? 'py-1' : ''}`}
          >
            <Action
              testId={X_TESTID.reply}
              label={`${shown.metrics.replies} replies. Reply`}
              count={shown.metrics.replies}
              hover="hover:text-accent"
              onClick={() => session.openReply(post)}
            >
              <ReplyIcon size={18} />
            </Action>
            <Action
              testId={X_TESTID.retweet}
              label={`${shown.metrics.reposts} reposts. Repost`}
              count={shown.metrics.reposts}
              hover="hover:text-repost"
              active={reposted ? 'text-repost' : undefined}
              pressed={reposted}
              onClick={() => toggle('repost')}
            >
              <RepostIcon size={18} />
            </Action>
            <Action
              testId={liked ? X_TESTID.unlike : X_TESTID.like}
              label={`${shown.metrics.likes} likes. Like`}
              count={shown.metrics.likes}
              hover="hover:text-like"
              active={liked ? 'text-like' : undefined}
              pressed={liked}
              onClick={() => toggle('like')}
            >
              <LikeIcon size={18} filled={liked} />
            </Action>
            <span
              className="flex min-w-[52px] items-center gap-1.5"
              aria-label={
                shown.metrics.views !== null ? `${shown.metrics.views} views` : undefined
              }
            >
              {shown.metrics.views !== null ? (
                <>
                  <ViewsIcon size={18} />
                  {formatCount(shown.metrics.views)}
                </>
              ) : null}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

function Byline({
  post,
  permalink,
  stacked = false,
}: {
  post: XPostDto;
  permalink: string;
  stacked?: boolean;
}) {
  return (
    <div
      data-testid={X_TESTID.userName}
      className={stacked ? 'min-w-0 leading-5' : 'flex min-w-0 items-baseline gap-1'}
    >
      <span className={`flex min-w-0 items-center gap-1 ${stacked ? '' : 'shrink'}`}>
        <Link href={`/${post.author.handle}`} className="truncate font-bold hover:underline">
          {post.author.displayName}
        </Link>
        {post.author.isBot ? (
          <span className="shrink-0 rounded border border-rule-strong px-1 text-[11px] leading-4 text-dim">
            Automated
          </span>
        ) : null}
      </span>
      <Link href={`/${post.author.handle}`} className="truncate text-dim" tabIndex={-1}>
        @{post.author.handle}
      </Link>
      {stacked ? null : (
        <>
          <span className="text-dim" aria-hidden="true">
            ·
          </span>
          <Link href={permalink} className="shrink-0 text-dim hover:underline">
            <time dateTime={post.createdAt}>{formatAge(post.createdAt)}</time>
          </Link>
        </>
      )}
    </div>
  );
}

function Action({
  testId,
  label,
  count,
  hover,
  active,
  pressed,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  count: number;
  hover: string;
  active?: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`-ml-2 flex min-w-[52px] items-center gap-1.5 rounded-full px-2 py-1.5 transition-colors ${hover} ${active ?? ''}`}
    >
      {children}
      <span>{count > 0 ? formatCount(count) : ''}</span>
    </button>
  );
}

const TOKEN = /(@[A-Za-z0-9_]{1,15}|https?:\/\/[^\s]+)/g;

/** Turn @handles and links in a post into anchors. Everything else is text. */
function RichText({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('@') && /^@[A-Za-z0-9_]{1,15}$/.test(part)) {
          return (
            <Link
              key={index}
              href={`/${part.slice(1).toLowerCase()}`}
              className="text-accent hover:underline"
            >
              {part}
            </Link>
          );
        }
        if (/^https?:\/\//.test(part)) {
          // Trailing punctuation belongs to the sentence, not the link.
          const url = part.replace(/[.,;:!?)]+$/, '');
          const rest = part.slice(url.length);
          return (
            <Fragment key={index}>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                {url.replace(/^https?:\/\//, '')}
              </a>
              {rest}
            </Fragment>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
