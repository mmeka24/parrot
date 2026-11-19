'use client';

import { Composer } from '@/components/Composer';
import { ColumnHeader, Notice, PostList } from '@/components/Shell';
import { getTimeline } from '@/lib/api';
import { usePolled } from '@/lib/session';

export default function HomePage() {
  const { data, error } = usePolled(getTimeline, 'timeline', 3_000);

  return (
    <>
      <ColumnHeader>
        <h1 className="text-[20px] font-bold leading-6">Home</h1>
      </ColumnHeader>

      <div className="border-b border-rule">
        <Composer allowVideo />
      </div>

      {data ? (
        data.posts.length > 0 ? (
          <PostList posts={[...data.posts]} />
        ) : (
          <Notice title="Nothing here yet" detail="Write the first post." />
        )
      ) : error ? (
        <Notice title="Chirp cannot reach its server" detail="Start the backend, then this page fills in by itself." />
      ) : (
        <Notice title="Loading" detail="Fetching the timeline." />
      )}
    </>
  );
}
