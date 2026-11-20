'use client';

/**
 * Who is signed in, for the whole app.
 *
 * Loads once on mount: is sign-in turned on at all, and if so, is there a
 * session. A freshly created account is given its starting balance a moment
 * after sign-in, so while that is still pending this polls briefly.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAuthConfig, getMe, signOut as apiSignOut, type AuthConfig, type Me } from './api';

export type AccountStatus = 'loading' | 'off' | 'out' | 'in';

interface AccountState {
  readonly status: AccountStatus;
  readonly config: AuthConfig | null;
  readonly me: Me | null;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const Ctx = createContext<AccountState>({
  status: 'loading',
  config: null,
  me: null,
  refresh: async () => undefined,
  signOut: async () => undefined,
});

export const useAccount = (): AccountState => useContext(Ctx);

/** Where to go after signing in. Only ever a path on this site. */
const NEXT_KEY = 'parrot_next';

export function rememberNext(path: string | null): void {
  try {
    if (path && path.startsWith('/') && !path.startsWith('//')) sessionStorage.setItem(NEXT_KEY, path);
  } catch {
    // storage blocked: sign-in still works, it just lands on the home page
  }
}

export function takeNext(): string | null {
  try {
    const v = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return v && v.startsWith('/') && !v.startsWith('//') ? v : null;
  } catch {
    return null;
  }
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccountStatus>('loading');
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const polls = useRef(0);

  const load = useCallback(async () => {
    const cfg = await getAuthConfig();
    setConfig(cfg);
    if (!cfg) {
      setStatus('off');
      return;
    }
    const current = await getMe();
    setMe(current);
    setStatus(current.signedIn ? 'in' : 'out');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from Google: carry on to where the person was headed.
  useEffect(() => {
    if (status !== 'in' || typeof window === 'undefined') return;
    if (!new URLSearchParams(window.location.search).has('welcome')) return;
    const next = takeNext();
    if (next) window.location.replace(next);
  }, [status]);

  // The starting balance lands a moment after a new account is created.
  useEffect(() => {
    if (status !== 'in' || !me || me.funding === 'funded' || polls.current >= 8) return;
    const id = setTimeout(() => {
      polls.current += 1;
      void getMe().then(setMe);
    }, 2500);
    return () => clearTimeout(id);
  }, [status, me]);

  const value = useMemo<AccountState>(
    () => ({
      status,
      config,
      me,
      refresh: async () => {
        polls.current = 0;
        await load();
      },
      signOut: async () => {
        await apiSignOut();
        polls.current = 0;
        setMe({ signedIn: false });
        setStatus('out');
      },
    }),
    [status, config, me, load],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
