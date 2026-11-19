'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X_TESTID } from '@parrot/shared';
import { formatCount } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { ChirpMark, CloseIcon, HomeIcon, UserIcon } from './icons';
import { PostCard } from './PostCard';

/** Three columns: who you are, the timeline, and what this place is. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-[1265px] justify-center">
      <SideNav />
      <main
        data-testid={X_TESTID.primaryColumn}
        className="min-h-screen w-full min-w-0 max-w-[600px] border-x border-rule"
      >
        {children}
      </main>
      <RightRail />
      <ReplyDialog />
    </div>
  );
}

function SideNav() {
  const pathname = usePathname();
  const { me } = useSession();
  const items = [
    { href: '/', label: 'Home', icon: HomeIcon, active: pathname === '/' },
    { href: `/${me}`, label: 'Profile', icon: UserIcon, active: pathname === `/${me}` },
  ];

  return (
    <header className="sticky top-0 flex h-screen w-[68px] shrink-0 flex-col items-center px-1 py-2 xl:w-[260px] xl:items-stretch xl:px-3">
      <Link
        href="/"
        aria-label="Chirp home"
        className="flex h-12 w-12 items-center justify-center rounded-full hover:bg-sunk xl:ml-0"
      >
        <ChirpMark />
      </Link>

      <nav aria-label="Primary" className="mt-1 flex flex-col items-center gap-1 xl:items-start">
        {items.map(({ href, label, icon: Icon, active }) => (
          <Link
            key={label}
            href={href}
            aria-current={active ? 'page' : undefined}
            className="flex items-center gap-4 rounded-full p-3 text-[20px] hover:bg-sunk xl:pr-6"
          >
            <Icon size={26} filled={active} />
            <span className={`hidden xl:inline ${active ? 'font-bold' : ''}`}>{label}</span>
          </Link>
        ))}
      </nav>

      <div className="mt-auto w-full">
        <AccountSwitcher />
      </div>
    </header>
  );
}

function AccountSwitcher() {
  const { me, setMe, users } = useSession();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const meUser = users.find((u) => u.handle === me);
  const people = users.filter((u) => !u.isBot);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false);
        return;
      }
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  function choose(handle: string): void {
    setMe(handle);
    setOpen(false);
    setCustom('');
  }

  return (
    <div ref={wrapRef} className="relative mb-2">
      {open ? (
        <div
          role="menu"
          aria-label="Switch account"
          className="absolute bottom-full left-0 z-30 mb-2 w-[280px] overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_0_15px_rgba(101,119,134,0.25)]"
        >
          <p className="px-4 pb-1 pt-3 text-[13px] text-dim">Post as</p>
          {people.map((user) => (
            <button
              key={user.handle}
              type="button"
              role="menuitemradio"
              aria-checked={user.handle === me}
              onClick={() => choose(user.handle)}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-hover"
            >
              <Avatar handle={user.handle} displayName={user.displayName} size={36} />
              <span className="min-w-0 flex-1 leading-5">
                <span className="block truncate font-bold">{user.displayName}</span>
                <span className="block truncate text-dim">@{user.handle}</span>
              </span>
              {user.handle === me ? (
                <span className="text-accent" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
          <form
            className="flex items-center gap-2 border-t border-rule px-4 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (/^@?[A-Za-z0-9_]{1,15}$/.test(custom)) choose(custom);
            }}
          >
            <input
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              aria-label="Another handle"
              placeholder="another handle"
              maxLength={16}
              className="min-w-0 flex-1 rounded-full border border-rule-strong bg-transparent px-3 py-1.5 text-[14px] outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="rounded-full border border-rule-strong px-3 py-1.5 text-[14px] font-bold hover:bg-hover"
            >
              Use
            </button>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        data-testid={X_TESTID.accountSwitcher}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu, posting as @${me}`}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-center gap-3 rounded-full p-2 text-left hover:bg-sunk xl:justify-start xl:p-3"
      >
        <Avatar handle={me} displayName={meUser?.displayName ?? me} />
        <span className="hidden min-w-0 flex-1 leading-5 xl:block">
          <span className="block truncate font-bold">{meUser?.displayName ?? me}</span>
          <span className="block truncate text-dim">@{me}</span>
        </span>
        <span className="hidden text-dim xl:inline" aria-hidden="true">
          ···
        </span>
      </button>
    </div>
  );
}

function RightRail() {
  const { users } = useSession();
  const people = users.filter((u) => !u.isBot);

  return (
    <aside className="sticky top-0 hidden h-screen w-[350px] shrink-0 flex-col gap-4 overflow-y-auto py-3 pl-7 pr-2 lg:flex">
      <section className="rounded-2xl bg-note px-4 py-3 text-on-note">
        <h2 className="text-[15px] font-bold">This is a stand-in, not X</h2>
        <p className="mt-1 text-[14px] leading-5">
          Chirp is a small timeline that runs on this computer. Posts here never leave it, and
          the sample clips have no footage behind them unless you upload a video yourself.
        </p>
      </section>

      <section className="overflow-hidden rounded-2xl border border-rule">
        <h2 className="px-4 py-3 text-[20px] font-extrabold leading-6">People here</h2>
        {people.map((user) => (
          <Link
            key={user.handle}
            href={`/${user.handle}`}
            className="flex items-center gap-3 px-4 py-3 hover:bg-hover"
          >
            <Avatar handle={user.handle} displayName={user.displayName} />
            <span className="min-w-0 flex-1 leading-5">
              <span className="block truncate font-bold">{user.displayName}</span>
              <span className="block truncate text-dim">@{user.handle}</span>
            </span>
            <span className="tabular shrink-0 text-[13px] text-dim">
              {formatCount(user.followers)} followers
            </span>
          </Link>
        ))}
      </section>
    </aside>
  );
}

/** The reply dialog. Opened by a post's reply button, as on x.com. */
function ReplyDialog() {
  const { replyingTo, closeReply } = useSession();

  useEffect(() => {
    if (!replyingTo) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeReply();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [replyingTo, closeReply]);

  if (!replyingTo) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-scrim px-3 pt-[5vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeReply();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Reply to @${replyingTo.author.handle}`}
        className="max-h-[88vh] w-full max-w-[600px] overflow-y-auto rounded-2xl bg-surface"
      >
        <div className="flex h-[53px] items-center px-2">
          <button
            type="button"
            aria-label="Close"
            onClick={closeReply}
            className="rounded-full p-2 hover:bg-sunk"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="flex gap-3 px-4 pb-1">
          <Avatar
            handle={replyingTo.author.handle}
            displayName={replyingTo.author.displayName}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1">
              <span className="truncate font-bold">{replyingTo.author.displayName}</span>
              <span className="truncate text-dim">@{replyingTo.author.handle}</span>
            </div>
            <p className="whitespace-pre-wrap break-words">{replyingTo.text}</p>
            <p className="py-3 text-dim">
              Replying to <span className="text-accent">@{replyingTo.author.handle}</span>
            </p>
          </div>
        </div>
        <Composer replyTo={replyingTo} inDialog autoFocus onPosted={closeReply} />
      </div>
    </div>
  );
}

/** The sticky title bar at the top of the middle column. */
export function ColumnHeader({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-20 flex h-[53px] items-center gap-6 border-b border-rule bg-surface/85 px-4 backdrop-blur">
      {children}
    </div>
  );
}

export function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="px-8 py-12 text-center">
      <h2 className="text-[20px] font-extrabold leading-6">{title}</h2>
      <p className="mt-2 text-dim">{detail}</p>
    </div>
  );
}

export function PostList({ posts }: { posts: Parameters<typeof PostCard>[0]['post'][] }) {
  return (
    <>
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
    </>
  );
}
