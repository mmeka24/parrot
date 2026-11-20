'use client';

import { useEffect, useRef, useState } from 'react';
import { DEMO_REACH_PRESETS, X_TESTID, type XPostDto } from '@parrot/shared';
import { ApiError, createPost, uploadVideo } from '@/lib/api';
import { formatClock, formatCount } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar } from './Avatar';
import { ClipIcon, CloseIcon } from './icons';

const MAX_LENGTH = 280;
const ACCEPTED = 'video/mp4,video/webm,video/quicktime';

interface Attachment {
  readonly file: File;
  readonly durationS: number;
}

/** Read a video file's length without uploading it. */
function probeDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    const done = () => {
      URL.revokeObjectURL(url);
      if (Number.isFinite(video.duration) && video.duration > 0) resolve(video.duration);
      else reject(new Error('unreadable'));
    };
    video.onloadedmetadata = () => {
      // WebM written by a browser's MediaRecorder (screen and webcam captures)
      // has no duration in its header, so it reports Infinity. Seeking past the
      // end makes the browser scan the file and report the real length.
      if (video.duration === Infinity) {
        video.ondurationchange = () => {
          if (Number.isFinite(video.duration)) {
            video.ondurationchange = null;
            done();
          }
        };
        video.currentTime = Number.MAX_SAFE_INTEGER;
        return;
      }
      done();
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };
    video.src = url;
  });
}

export function Composer({
  replyTo = null,
  inDialog = false,
  allowVideo = false,
  autoFocus = false,
  onPosted,
}: {
  replyTo?: XPostDto | null;
  /** The reply dialog and the inline composer carry different submit hooks on x.com. */
  inDialog?: boolean;
  allowVideo?: boolean;
  autoFocus?: boolean;
  onPosted?: (post: XPostDto) => void;
}) {
  const session = useSession();
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  // Demo reach for a video post. A post written a moment ago has no views, so
  // the agents would pass on it; this gives it the reach a viral clip has.
  const [reach, setReach] = useState<number>(1_200_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const meUser = session.users.find((u) => u.handle === session.me);
  const remaining = MAX_LENGTH - text.length;
  const canPost = text.trim() !== '' && remaining >= 0 && !busy;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Grow with the text, like every composer does.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function attach(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    try {
      setAttachment({ file, durationS: await probeDuration(file) });
    } catch {
      setError('That video could not be read. Try an MP4.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function submit(): Promise<void> {
    if (!canPost) return;
    setBusy(true);
    setError(null);
    try {
      const media = attachment ? await uploadVideo(attachment.file) : null;
      const post = await createPost({
        text: text.trim(),
        authorHandle: session.me,
        inReplyToId: replyTo?.id ?? null,
        video: media && attachment ? { mediaId: media.mediaId, durationS: attachment.durationS } : null,
        simulatedViews: media && !replyTo ? reach : null,
      });
      setText('');
      setAttachment(null);
      session.bump();
      onPosted?.(post);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.title}. ${err.detail}` : 'That did not send. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-3 px-4 py-3">
      <Avatar handle={session.me} displayName={meUser?.displayName ?? session.me} />
      <div className="min-w-0 flex-1">
        <textarea
          ref={inputRef}
          data-testid={X_TESTID.composerInput}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
          }}
          rows={inDialog ? 3 : 1}
          aria-label={replyTo ? 'Post your reply' : 'Post text'}
          placeholder={replyTo ? 'Post your reply' : 'What is happening?'}
          className="block w-full resize-none bg-transparent py-2 text-[20px] leading-6 outline-none placeholder:text-dim"
        />

        {attachment ? (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-rule px-3 py-2 text-[14px]">
            <ClipIcon size={18} />
            <span className="min-w-0 flex-1 truncate">{attachment.file.name}</span>
            <span className="tabular shrink-0 text-dim">{formatClock(attachment.durationS)}</span>
            <button
              type="button"
              aria-label="Remove video"
              onClick={() => setAttachment(null)}
              className="rounded-full p-1 text-dim hover:bg-sunk hover:text-ink"
            >
              <CloseIcon size={16} />
            </button>
          </div>
        ) : null}

        {attachment && !replyTo ? (
          <label className="mb-2 flex items-center gap-2 text-[13px] text-dim">
            Simulated reach (demo)
            <select
              value={reach}
              onChange={(event) => setReach(Number(event.target.value))}
              className="rounded-md border border-rule bg-transparent px-2 py-1 text-ink"
            >
              {DEMO_REACH_PRESETS.map((views) => (
                <option key={views} value={views}>
                  {formatCount(views)} views
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="mb-2 text-[14px] text-like">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between border-t border-rule pt-2">
          <div className="flex items-center">
            {allowVideo ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPTED}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => void attach(event.target.files?.[0])}
                />
                <button
                  type="button"
                  aria-label="Add a video"
                  title="Add a video"
                  onClick={() => fileRef.current?.click()}
                  className="-ml-2 rounded-full p-2 text-accent hover:bg-sunk"
                >
                  <ClipIcon size={20} />
                </button>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {text.length > MAX_LENGTH - 40 ? (
              <span className={`tabular text-[13px] ${remaining < 0 ? 'text-like' : 'text-dim'}`}>
                {remaining}
              </span>
            ) : null}
            <button
              type="button"
              data-testid={inDialog ? X_TESTID.composerSubmit : X_TESTID.composerSubmitInline}
              disabled={!canPost}
              onClick={() => void submit()}
              className="rounded-full bg-ink px-4 py-1.5 font-bold text-surface transition-opacity disabled:opacity-50"
            >
              {busy ? 'Posting' : replyTo ? 'Reply' : 'Post'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
