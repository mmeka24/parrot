'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { BotConsoleDto, BotPostDto } from '@parrot/shared';
import { copy, fill, SUPPORTED_LANGUAGES } from '@parrot/shared';
import { injectMention } from '@/lib/api';
import { heroDubId } from '@/lib/fixtures';
import { localCopy } from '@/lib/local-copy';
import { EmptyState, ParrotAvatar, formatCount, formatWhen } from './ui';

const SUGGESTIONS = [
  '@parrot dub this to Spanish',
  '@parrot dub this to Hindi',
  '@parrot dub this to Korean',
];

/** Offline stand-in for the backend's parser: find a supported language name. */
function detectLanguage(text: string): string | null {
  const lower = text.toLowerCase();
  const hit = SUPPORTED_LANGUAGES.find((lang) => lower.includes(lang.englishName.toLowerCase()));
  return hit ? hit.englishName : null;
}

export function BotConsole({ initial }: { initial: BotConsoleDto }) {
  const [posts, setPosts] = useState<readonly BotPostDto[]>(initial.posts);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [seq, setSeq] = useState(0);

  async function send(value: string) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    setText('');

    const live = await injectMention({ text: trimmed, authorHandle: 'you' });
    if (live) {
      setPosts((prev) => [...live, ...prev]);
      setSending(false);
      return;
    }

    const n = seq + 1;
    setSeq(n);
    const now = new Date().toISOString();
    const mention: BotPostDto = {
      id: 'local_mention_' + n,
      authorHandle: 'you',
      authorDisplayName: 'You',
      text: trimmed,
      createdAt: now,
      isBot: false,
      inReplyToId: null,
      metrics: null,
      hasVideo: true,
      jobId: null,
    };

    const language = detectLanguage(trimmed);
    const reply: BotPostDto = {
      id: 'local_reply_' + n,
      authorHandle: 'parrot',
      authorDisplayName: localCopy.console.botLabel,
      text:
        language === null
          ? copy.bot.declinedReply.replace(
              '{reason}',
              copy.bot.declineReasonUnsupportedLanguage,
            )
          : fill(copy.bot.acceptedReply, { language }),
      createdAt: now,
      isBot: true,
      inReplyToId: mention.id,
      metrics: null,
      hasVideo: false,
      jobId: language === null ? null : heroDubId,
    };

    setPosts((prev) => [reply, mention, ...prev]);
    setSending(false);
  }

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.25rem' }}>
      <section className="panel stack" style={{ ['--stack' as string]: '0.75rem' }}>
        <label htmlFor="mention" style={{ fontWeight: 650 }}>
          {localCopy.console.inputLabel}
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
          <input
            id="mention"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send(text);
            }}
            placeholder={localCopy.console.inputPlaceholder}
            style={{
              flex: '1 1 16rem',
              minHeight: 48,
              padding: '0.7rem 1rem',
              borderRadius: 999,
              border: '1px solid var(--rule-strong)',
              background: 'var(--paper-sunk)',
              color: 'var(--ink)',
              font: 'inherit',
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={sending || text.trim().length === 0}
            onClick={() => void send(text)}
          >
            {sending ? localCopy.console.sendingCta : localCopy.console.sendCta}
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--ink-faint)' }}>
            {localCopy.console.hintTitle}
          </span>
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      </section>

      {posts.length === 0 ? (
        <section className="panel">
          <EmptyState title={localCopy.console.emptyTitle} body={localCopy.console.emptyBody} />
        </section>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.75rem' }}>
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </ol>
      )}
    </div>
  );
}

function PostCard({ post }: { post: BotPostDto }) {
  return (
    <li
      className="panel fade-in"
      style={{
        display: 'flex',
        gap: '0.85rem',
        padding: '1rem',
        borderColor: post.isBot ? 'color-mix(in srgb, var(--mango) 38%, var(--rule))' : 'var(--rule)',
      }}
    >
      <ParrotAvatar isBot={post.isBot} handle={post.authorHandle} />
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: '0.35rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'baseline' }}>
          <strong>{post.authorDisplayName}</strong>
          <span style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>@{post.authorHandle}</span>
          {post.isBot ? <span className="chip chip-accent">{localCopy.console.botLabel}</span> : null}
          <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--ink-faint)' }}>
            {formatWhen(post.createdAt)}
          </span>
        </div>

        <p style={{ fontSize: '0.96rem' }}>{post.text}</p>

        {post.hasVideo ? <span className="chip chip-teal">{localCopy.console.videoBadge}</span> : null}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.85rem',
            fontSize: '0.75rem',
            color: 'var(--ink-faint)',
          }}
        >
          {post.metrics ? (
            <>
              <span className="num">{formatCount(post.metrics.likes)} {localCopy.console.likes}</span>
              <span className="num">{formatCount(post.metrics.replies)} {localCopy.console.replies}</span>
              <span className="num">{formatCount(post.metrics.reposts)} {localCopy.console.reposts}</span>
              {post.metrics.views !== null ? (
                <span className="num">{formatCount(post.metrics.views)} {localCopy.console.views}</span>
              ) : null}
            </>
          ) : null}
          {post.jobId ? (
            <Link href={'/dub/' + post.jobId} style={{ color: 'var(--sky)', fontWeight: 600 }}>
              {localCopy.console.openDub}
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}
