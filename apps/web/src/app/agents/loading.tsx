import { SkeletonPanel } from '@/components/ui';

export default function Loading() {
  return (
    <div className="stack" style={{ ['--stack' as string]: '1.25rem' }}>
      <SkeletonPanel rows={2} />
      <SkeletonPanel rows={4} />
    </div>
  );
}
