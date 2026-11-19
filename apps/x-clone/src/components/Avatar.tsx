import { hueFor } from '@/lib/format';

/** Initials on a colour that is stable per handle. No photos: nothing to host. */
export function Avatar({
  handle,
  displayName,
  size = 40,
}: {
  handle: string;
  displayName: string;
  size?: number;
}) {
  const hue = hueFor(handle);
  const initials = displayName
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `hsl(${hue} 55% 42%)`,
      }}
    >
      {initials || '?'}
    </span>
  );
}
