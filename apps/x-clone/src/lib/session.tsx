'use client';

/**
 * Who you are on Chirp, and the few bits of state the whole page shares.
 *
 * There is no sign-in: you pick an account from the switcher and Chirp posts as
 * it. That is the point of a stand-in - one person can play the creator and
 * then a passer-by - and it is why this would be a hole anywhere but localhost.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { XPostDto, XUserDto } from '@parrot/shared';
import { getTimeline } from './api';

const STORAGE_KEY = 'chirp.account';
const DEFAULT_ACCOUNT = 'maria';

interface SessionValue {
  readonly me: string;
  readonly setMe: (handle: string) => void;
  readonly users: readonly XUserDto[];
  /** The post the reply dialog is open on, if any. */
  readonly replyingTo: XPostDto | null;
  readonly openReply: (post: XPostDto) => void;
  readonly closeReply: () => void;
  /** Bumped whenever something was posted, so lists refetch at once. */
  readonly version: number;
  readonly bump: () => void;
  readonly isMarked: (kind: 'like' | 'repost', postId: string) => boolean;
  readonly setMarked: (kind: 'like' | 'repost', postId: string, on: boolean) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState(DEFAULT_ACCOUNT);
  const [users, setUsers] = useState<readonly XUserDto[]>([]);
  const [replyingTo, setReplyingTo] = useState<XPostDto | null>(null);
  const [version, setVersion] = useState(0);
  const [marks, setMarks] = useState<ReadonlySet<string>>(new Set());

  // Read the remembered account after mount, so the server render and the
  // first client render agree.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && /^[a-z0-9_]{1,15}$/.test(stored)) setMeState(stored);
    } catch {
      // Storage can be blocked; the default account is fine.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      getTimeline()
        .then((timeline) => {
          if (!cancelled) setUsers(timeline.users);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [version]);

  const setMe = useCallback((handle: string) => {
    const clean = handle.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(clean)) return;
    setMeState(clean);
    try {
      window.localStorage.setItem(STORAGE_KEY, clean);
    } catch {
      // Not remembered across reloads, which is acceptable.
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      me,
      setMe,
      users,
      replyingTo,
      openReply: setReplyingTo,
      closeReply: () => setReplyingTo(null),
      version,
      bump: () => setVersion((v) => v + 1),
      isMarked: (kind, postId) => marks.has(`${me}:${kind}:${postId}`),
      setMarked: (kind, postId, on) =>
        setMarks((current) => {
          const next = new Set(current);
          const key = `${me}:${kind}:${postId}`;
          if (on) next.add(key);
          else next.delete(key);
          return next;
        }),
    }),
    [me, setMe, users, replyingTo, version, marks],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

/**
 * Fetch, then keep fetching. Refetches immediately when `version` changes, so
 * a post you just wrote appears without waiting for the next tick.
 */
export function usePolled<T>(
  load: () => Promise<T>,
  key: string,
  intervalMs: number,
): { data: T | null; error: Error | null } {
  const { version } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = (): void => {
      load()
        .then((next) => {
          if (cancelled) return;
          setData(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
        });
    };
    run();
    const timer = window.setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `load` is recreated every render; `key` is what identifies the resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs, version]);

  return { data, error };
}
