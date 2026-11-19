'use client';

import { useParams, useRouter } from 'next/navigation';
import { Composer } from '@/components/Composer';
import { BackIcon } from '@/components/icons';
import { PostCard } from '@/components/PostCard';
import { ColumnHeader, Notice, PostList } from '@/components/Shell';
import { ApiError, getThread } from '@/lib/api';
import { usePolled } from '@/lib/session';

export default function ThreadPage() {
  const params = useParams<{ handle: string; id: string }>();
  const router = useRouter();
  const id = decodeURIComponent(params.id);
  // Fast enough that an answer to a reply shows up while you are still looking.
  const { data, error } = usePolled(() => getThread(id), `thread:${id}`, 1_500);

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
        <h1 className="text-[20px] font-bold leading-6">Post</h1>
      </ColumnHeader>

      {data ? (
        <>
          <PostList posts={[...data.ancestors]} />
          <PostCard post={data.post} variant="focus" />
          <div className="border-b border-rule">
            <Composer replyTo={data.post} />
          </div>
          <PostList posts={[...data.replies]} />
        </>
      ) : error ? (
        error instanceof ApiError && error.status === 404 ? (
          <Notice title="This post does not exist" detail="It may have been removed." />
        ) : (
          <Notice title="Chirp cannot reach its server" detail="Start the backend and reload." />
        )
      ) : (
        <Notice title="Loading" detail="Fetching the conversation." />
      )}
    </>
  );
}
