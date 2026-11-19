/** 5400 -> "5.4K", 92000 -> "92K", 1200000 -> "1.2M". */
export function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const k = value / 1_000;
    return `${k < 100 ? trim(k) : Math.round(k)}K`;
  }
  return `${trim(value / 1_000_000)}M`;
}

function trim(value: number): string {
  return (Math.floor(value * 10) / 10).toString();
}

/** "now", "4m", "3h", "2d", then a calendar date. */
export function formatAge(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'now';
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatFull(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** 95 -> "1:35". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A stable hue per handle, for avatars and clip posters. */
export function hueFor(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}
