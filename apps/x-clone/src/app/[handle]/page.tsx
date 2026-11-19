'use client';

import { useParams, useRouter } from 'next/navigation';
import { Avatar } from '@/components/Avatar';
import { BackIcon } from '@/components/icons';
import { ColumnHeader, Notice, PostList } from '@/components/Shell';
import { getTimeline } from '@/lib/api';
import { formatCount, hueFor } from '@/lib/format';
import { usePolled, useSession } from '@/lib/session';

export default function ProfilePage() {
  const params = useParams<{ handle: string }>();
  const router = useRouter();
  const { me, setMe } = useSession();
  const handle = decodeURIComponent(params.handle).toLowerCase();
  const { data, error } = usePolled(getTimeline, 'timeline', 4_000);

  const user = data?.users.find((u) => u.handle === handle);
  const posts = data?.posts.filter((p) => p.author.handle === handle) ?? [];

  return (
    <>
      <ColumnHeader>
        <button
          type="button"
          aria-label="Back"
          onClick={() => router.push('/')}
          className="-ml-2 rounded-full p-2 hover:bg-sunk"
        >
          <BackIcon />
        </button>
        <div className="min-w-0 leading-5">
          <h1 className="truncate text-[20px] font-bold leading-6">
            {user?.displayName ?? `@${handle}`}
          </h1>
          {user ? (
            <p className="text-[13px] text-dim">
              {posts.length} {posts.length === 1 ? 'post' : 'posts'}
            </p>
          ) : null}
        </div>
      </ColumnHeader>

      {!data ? (
        error ? (
          <Notice title="Chirp cannot reach its server" detail="Start the backend and reload." />
        ) : (
          <Notice title="Loading" detail="Fetching the profile." />
        )
      ) : !user ? (
        <Notice title="This account does not exist" detail="Try another handle." />
      ) : (
        <>
          <div
            className="h-[160px]"
            style={{
              background: `linear-gradient(120deg, hsl(${hueFor(handle)} 50% 45%), hsl(${(hueFor(handle) + 60) % 360} 55% 30%))`,
            }}
          />
          <div className="border-b border-rule px-4 pb-4">
            <div className="-mt-10 flex items-end justify-between">
              <span className="rounded-full border-4 border-surface">
                <Avatar handle={user.handle} displayName={user.displayName} size={96} />
              </span>
              {user.isBot ? null : user.handle === me ? (
                <span className="rounded-full border border-rule-strong px-4 py-1.5 font-bold text-dim">
                  Posting as this account
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setMe(user.handle)}
                  className="rounded-full border border-rule-strong px-4 py-1.5 font-bold hover:bg-hover"
                >
                  Post as @{user.handle}
                </button>
              )}
            </div>
            <h2 className="mt-2 flex items-center gap-2 text-[20px] font-extrabold leading-6">
              {user.displayName}
              {user.isBot ? (
                <span className="rounded border border-rule-strong px-1 text-[11px] font-normal leading-4 text-dim">
                  Automated
                </span>
              ) : null}
            </h2>
            <p className="text-dim">@{user.handle}</p>
            {user.isBot ? null : (
              <p className="mt-2 text-dim">
                <span className="tabular font-bold text-ink">{formatCount(user.followers)}</span>{' '}
                Followers
              </p>
            )}
          </div>

          {posts.length > 0 ? (
            <PostList posts={posts} />
          ) : (
            <Notice
              title={user.isBot ? 'Replies only' : 'No posts yet'}
              detail={
                user.isBot
                  ? 'This account answers people in threads and does not post on its own.'
                  : `@${user.handle} has not posted.`
              }
            />
          )}
        </>
      )}
    </>
  );
}
