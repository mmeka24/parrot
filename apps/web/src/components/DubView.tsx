'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiErrorDto, DubPageDto, MoneyDto, ReceiptDto } from '@parrot/shared';
import { copy, fill, isPublished } from '@parrot/shared';
import { useAccount } from '@/lib/account';
import { unlockDub } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';
import { ReceiptDrawer } from './ReceiptDrawer';
import { formatCount } from './ui';

type Phase = 'locked' | 'unlocking' | 'unlocked';

export function DubView({ dub }: { dub: DubPageDto }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const account = useAccount();

  const [phase, setPhase] = useState<Phase>(dub.unlocked ? 'unlocked' : 'locked');
  const [src, setSrc] = useState<string | null>(dub.unlocked ? dub.fullUrl : dub.previewUrl);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [gateHit, setGateHit] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [mediaBroken, setMediaBroken] = useState(false);
  const [shared, setShared] = useState(false);
  const [justUnlocked, setJustUnlocked] = useState(false);
  const [balance, setBalance] = useState<MoneyDto | null>(dub.viewerBalance);
  const [receipts, setReceipts] = useState<readonly ReceiptDto[]>(dub.receipts);
  const [error, setError] = useState<ApiErrorDto | null>(null);

  // With accounts on, only a signed-in person can unlock. A session that ended
  // while the page was open comes back from the server as SIGN_IN_REQUIRED.
  //
  // Before the account state has loaded, the server's own answer is the hint:
  // with accounts on, a signed-out viewer comes back with no balance at all
  // (the old guest flow always gave one). That avoids a flash of an unlock
  // button that is about to turn into a sign-in prompt.
  const signedOutHint = dub.viewerBalance === null && !dub.unlocked;
  const needsSignIn =
    phase !== 'unlocked' &&
    (account.status === 'out' ||
      (account.status === 'loading' && signedOutHint) ||
      (error !== null && error.code === 'SIGN_IN_REQUIRED'));
  const accountsOn = account.status === 'out' || account.status === 'in';
  const signInHref = '/signin?next=' + encodeURIComponent('/dub/' + dub.jobId);

  const playable = isPublished(dub.state) && src !== null;

  // Preview gate: stop at previewSeconds until this viewer has unlocked.
  const onTimeUpdate = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    setElapsed(el.currentTime);
    if (phase !== 'unlocked' && el.currentTime >= dub.previewSeconds) {
      el.pause();
      el.currentTime = dub.previewSeconds;
      setPlaying(false);
      setGateHit(true);
    }
  }, [dub.previewSeconds, phase]);

  useEffect(() => {
    if (phase === 'unlocked') setGateHit(false);
  }, [phase]);

  async function play() {
    const el = videoRef.current;
    if (!el) return;
    setStarted(true);
    try {
      await el.play();
      setPlaying(true);
    } catch {
      setMediaBroken(true);
    }
  }

  function pause() {
    videoRef.current?.pause();
    setPlaying(false);
  }

  async function onUnlock() {
    setError(null);
    setPhase('unlocking');
    const result = await unlockDub(dub.jobId, dub);
    if (!result.ok) {
      setPhase('locked');
      setError(result);
      if (result.code === 'SIGN_IN_REQUIRED') void account.refresh();
      return;
    }
    setPhase('unlocked');
    setJustUnlocked(true);
    setGateHit(false);
    setBalance(result.viewerBalance);
    void account.refresh(); // keep the header balance honest
    setReceipts([result.receipt, ...receipts]);
    setSrc(result.fullUrl);

    // Instant playback: carry on from exactly where the preview stopped.
    requestAnimationFrame(() => {
      const el = videoRef.current;
      if (!el) return;
      const resumeAt = Math.min(elapsed, dub.previewSeconds);
      const resume = () => {
        el.currentTime = resumeAt;
        void el.play().then(() => setPlaying(true)).catch(() => setMediaBroken(true));
        el.removeEventListener('loadedmetadata', resume);
      };
      if (el.readyState >= 1) resume();
      else el.addEventListener('loadedmetadata', resume);
    });
  }

  async function onShare() {
    const url = typeof window === 'undefined' ? '' : window.location.href;
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: localCopy.dub.shareTitle, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 2200);
    } catch {
      setShared(false);
    }
  }

  const previewPct = Math.min(100, (elapsed / Math.max(dub.previewSeconds, 1)) * 100);

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.25rem' }}>
      {/* ------------------------------------------------------------ player */}
      <div
        style={{
          position: 'relative',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          border: '1px solid var(--rule)',
          background: '#0c0b09',
          boxShadow: 'var(--shadow-lift)',
          aspectRatio: '16 / 9',
        }}
      >
        {playable && !mediaBroken ? (
          <video
            ref={videoRef}
            src={src ?? undefined}
            playsInline
            preload="metadata"
            poster={dub.posterUrl ?? undefined}
            onTimeUpdate={onTimeUpdate}
            onEnded={() => setPlaying(false)}
            onError={() => setMediaBroken(true)}
            controls={phase === 'unlocked' && started}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <PosterFallback dub={dub} broken={mediaBroken} />
        )}

        {/* big play / pause affordance */}
        {playable && !mediaBroken && !gateHit ? (
          <button
            type="button"
            onClick={playing ? pause : play}
            aria-label={playing ? localCopy.dub.pause : started ? localCopy.dub.playFull : localCopy.dub.playPreview}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              border: 0,
              background: started && playing ? 'transparent' : 'rgba(10,8,5,0.35)',
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
            }}
          >
            {!playing ? (
              <span
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 999,
                  background: 'var(--mango)',
                  color: 'var(--on-accent)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: '1.6rem',
                  boxShadow: '0 12px 30px -10px rgba(0,0,0,0.6)',
                }}
                aria-hidden
              >
                ▶
              </span>
            ) : null}
          </button>
        ) : null}

        {/* preview-ended gate */}
        {gateHit && phase !== 'unlocked' ? (
          <div
            className="fade-in"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(180deg, rgba(10,8,5,0.35), rgba(10,8,5,0.88))',
              display: 'grid',
              placeItems: 'center',
              padding: '1.25rem',
              textAlign: 'center',
              color: '#fffdfa',
            }}
          >
            <div style={{ display: 'grid', gap: '0.6rem', justifyItems: 'center', maxWidth: '22rem' }}>
              <h2 style={{ color: '#fffdfa', fontSize: '1.5rem' }}>{copy.viewer.previewEndedTitle}</h2>
              <p style={{ fontSize: '0.95rem', opacity: 0.9 }}>{copy.viewer.previewEndedBody}</p>
            </div>
          </div>
        ) : null}

        {/* top-left badges */}
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            display: 'flex',
            gap: '0.4rem',
            flexWrap: 'wrap',
          }}
        >
          <span className="chip chip-teal" style={{ background: 'rgba(8,8,6,0.72)', color: '#eafff7', borderColor: 'rgba(255,255,255,0.25)' }}>
            {fill(copy.viewer.dubbedInto, { language: dub.targetLanguageName })}
          </span>
          {phase !== 'unlocked' ? (
            <span className="chip" style={{ background: 'rgba(8,8,6,0.72)', color: '#fff1e2', borderColor: 'rgba(255,255,255,0.25)' }}>
              {copy.viewer.previewBadge}
            </span>
          ) : null}
        </div>

        {/* preview progress */}
        {phase !== 'unlocked' && playable && !mediaBroken ? (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 4,
              background: 'rgba(255,255,255,0.22)',
            }}
          >
            <div
              style={{
                width: previewPct + '%',
                height: '100%',
                background: 'var(--mango)',
                transition: 'width 220ms linear',
              }}
            />
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------- title + attribution */}
      <div className="stack" style={{ ['--stack' as string]: '0.6rem' }}>
        <h1 style={{ fontSize: '1.7rem' }}>
          {fill(copy.viewer.dubbedInto, { language: dub.targetLanguageName })}
        </h1>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '0.5rem 0.9rem',
            color: 'var(--ink-soft)',
            fontSize: '0.9rem',
          }}
        >
          <span>
            {localCopy.dub.creatorPrefix}{' '}
            <Link
              href={'/creator/' + dub.creator.handle}
              style={{ fontWeight: 650, color: 'var(--ink)' }}
            >
              {dub.creator.displayName}
            </Link>{' '}
            <span style={{ color: 'var(--ink-faint)' }}>@{dub.creator.handle}</span>
          </span>
          {dub.sourceLanguageName ? (
            <span>{fill(copy.viewer.originalLanguage, { language: dub.sourceLanguageName })}</span>
          ) : null}
          <span className="num">{fill(localCopy.dub.viewsLabel, { count: formatCount(dub.viewCount) })}</span>
          <span className="num">{fill(localCopy.dub.unlocksLabel, { count: formatCount(dub.unlockCount) })}</span>
        </div>
      </div>

      {/* ------------------------------------------------------------ unlock */}
      {isPublished(dub.state) ? (
        <section className="panel stack" style={{ ['--stack' as string]: '0.85rem' }}>
          {phase === 'unlocked' ? (
            <div className="fade-in stack" style={{ ['--stack' as string]: '0.4rem' }}>
              <h2 className="panel-title">{copy.viewer.unlockedTitle}</h2>
              <p className="panel-sub">{copy.viewer.unlockedBody}</p>
            </div>
          ) : needsSignIn ? (
            <div className="stack" style={{ ['--stack' as string]: '0.4rem' }}>
              <h2 className="panel-title">{localCopy.account.needsSignInTitle}</h2>
              <p className="panel-sub">
                {fill(localCopy.account.needsSignInBody, { bonus: account.config?.bonus ?? '$1.00' })}
              </p>
            </div>
          ) : (
            <div className="stack" style={{ ['--stack' as string]: '0.4rem' }}>
              <h2 className="panel-title">{copy.viewer.previewEndedTitle}</h2>
              <p className="panel-sub">{copy.viewer.previewEndedBody}</p>
            </div>
          )}

          {error && error.code !== 'SIGN_IN_REQUIRED' ? (
            <div
              role="alert"
              className="fade-in"
              style={{
                background: 'var(--berry-wash)',
                border: '1px solid color-mix(in srgb, var(--berry) 40%, transparent)',
                borderRadius: 'var(--radius)',
                padding: '0.85rem 1rem',
              }}
            >
              <strong style={{ display: 'block', color: 'var(--berry)' }}>{error.title}</strong>
              <span style={{ fontSize: '0.88rem', color: 'var(--ink-soft)' }}>{error.detail}</span>
            </div>
          ) : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            {phase === 'unlocked' ? (
              <button type="button" className="btn btn-primary btn-lg" onClick={play}>
                {copy.viewer.rewatchCta}
              </button>
            ) : needsSignIn ? (
              <Link className="btn btn-primary btn-lg" href={signInHref} style={{ flex: '1 1 14rem', textAlign: 'center' }}>
                {localCopy.account.needsSignInCta}
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={onUnlock}
                disabled={phase === 'unlocking'}
                style={{ flex: '1 1 14rem' }}
              >
                {phase === 'unlocking'
                  ? copy.viewer.unlockingCta
                  : error
                    ? copy.errors.retryCta
                    : fill(copy.viewer.unlockCta, { price: dub.price.display })}
              </button>
            )}

            <button type="button" className="btn btn-secondary btn-lg" onClick={onShare}>
              {shared ? copy.viewer.shareCopied : copy.viewer.shareCta}
            </button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
            {balance ? (
              <span className="chip chip-teal">
                {copy.viewer.balanceLabel}: {balance.display}
              </span>
            ) : null}
            {accountsOn ? null : (
              <>
                <span className="chip chip-accent">
                  {fill(copy.viewer.starterCreditTitle, { amount: '$1.00' })}
                </span>
                <span className="chip chip-muted" aria-disabled="true">
                  {copy.viewer.cardSoon}
                </span>
              </>
            )}
          </div>
          {accountsOn ? null : (
            <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)' }}>
              {copy.viewer.starterCreditBody}
            </p>
          )}
        </section>
      ) : (
        <UnavailableNotice dub={dub} />
      )}

      {/* ---------------------------------------------------------- receipts */}
      <ReceiptDrawer receipts={receipts} />

      {/* --------------------------------------------------------- explainer */}
      <section className="panel stack" style={{ ['--stack' as string]: '0.4rem' }}>
        <h2 className="panel-title">{copy.viewer.howItWorksTitle}</h2>
        <p className="panel-sub">{copy.viewer.howItWorksBody}</p>
        <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)' }}>{copy.viewer.poweredBy}</p>
      </section>

      {justUnlocked ? <span className="sr-only" role="status">{copy.viewer.unlockedTitle}</span> : null}
    </div>
  );
}

function PosterFallback({ dub, broken }: { dub: DubPageDto; broken: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
        padding: '1.5rem',
        color: '#fffdfa',
        background:
          'radial-gradient(120% 120% at 20% 10%, #1d4d47 0%, #12110d 55%), linear-gradient(120deg, #f26a1b22, transparent)',
      }}
    >
      <div style={{ display: 'grid', gap: '0.4rem', justifyItems: 'center', maxWidth: '24rem' }}>
        <strong style={{ fontSize: '1.1rem' }}>
          {broken ? localCopy.dub.mediaErrorTitle : copy.errors.dubUnavailableTitle}
        </strong>
        <span style={{ fontSize: '0.9rem', opacity: 0.85 }}>
          {broken ? localCopy.dub.mediaErrorBody : copy.errors.dubUnavailableBody}
        </span>
        <span className="chip" style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', borderColor: 'rgba(255,255,255,0.3)' }}>
          {dub.targetLanguageName}
        </span>
      </div>
    </div>
  );
}

function UnavailableNotice({ dub }: { dub: DubPageDto }) {
  const scrapped = dub.state === 'REJECTED_BY_QC';
  const failed = dub.state === 'FAILED';
  const declined = dub.state === 'DECLINED';

  const title = scrapped
    ? copy.errors.dubbingFailedTitle
    : failed
      ? copy.errors.genericTitle
      : declined
        ? copy.errors.dubUnavailableTitle
        : localCopy.dub.stillDubbingTitle;

  const body = scrapped
    ? copy.errors.dubbingFailedBody
    : failed
      ? copy.errors.genericBody
      : declined
        ? copy.errors.dubUnavailableBody
        : localCopy.dub.stillDubbingBody;

  return (
    <section className="panel stack" style={{ ['--stack' as string]: '0.75rem' }}>
      <span className="chip chip-berry">{localCopy.dub.notReadyBadge}</span>
      <h2 className="panel-title">{title}</h2>
      <p className="panel-sub">{body}</p>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <Link className="btn btn-secondary" href={'/creator/' + dub.creator.handle}>
          {copy.creator.dashboardTitle}
        </Link>
        <Link className="btn btn-ghost" href="/">
          {copy.errors.backCta}
        </Link>
      </div>
    </section>
  );
}
