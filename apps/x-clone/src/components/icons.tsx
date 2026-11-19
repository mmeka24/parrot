/** Chirp's icons. Plain stroked glyphs, drawn here rather than borrowed. */

interface IconProps {
  readonly size?: number;
  readonly filled?: boolean;
}

function Svg({
  size = 20,
  children,
  fill = 'none',
}: {
  size?: number;
  children: React.ReactNode;
  fill?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The Chirp mark: a speech bubble with a single note in it. */
export function ChirpMark({ size = 28 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M16 4C8.8 4 3 9 3 15.2c0 3.4 1.8 6.5 4.6 8.5L6.5 28l5.3-2.2c1.3.4 2.7.6 4.2.6 7.2 0 13-5 13-11.2S23.2 4 16 4Z"
        fill="var(--accent)"
      />
      <path
        d="M10.5 15.5h4.2M17.3 12l4.2 3.5-4.2 3.5"
        stroke="var(--on-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function HomeIcon({ size, filled }: IconProps) {
  return (
    <Svg size={size} fill={filled ? 'currentColor' : 'none'}>
      <path d="M3.5 10.5 12 3.5l8.5 7v9a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1v-9Z" />
    </Svg>
  );
}

export function UserIcon({ size, filled }: IconProps) {
  return (
    <Svg size={size} fill={filled ? 'currentColor' : 'none'}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20.5c.8-4 4-6 8-6s7.2 2 8 6" />
    </Svg>
  );
}

export function ReplyIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20.5 11.5c0 4.1-3.8 7.5-8.5 7.5-1.1 0-2.2-.2-3.200-.5L4 20l1.300-3.600c-1.100-1.300-1.800-3-1.800-4.900C3.500 7.400 7.300 4 12 4s8.500 3.400 8.500 7.500Z" />
    </Svg>
  );
}

export function RepostIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7 7h9a3 3 0 0 1 3 3v6" />
      <path d="m16 13.500 3 3 3-3" />
      <path d="M17 17H8a3 3 0 0 1-3-3V8" />
      <path d="M8 10.500 5 7.500l-3 3" />
    </Svg>
  );
}

export function LikeIcon({ size, filled }: IconProps) {
  return (
    <Svg size={size} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 20.500s-7.500-4.600-7.500-10.200A4.300 4.300 0 0 1 12 7.600a4.300 4.300 0 0 1 7.500 2.700c0 5.600-7.500 10.200-7.500 10.200Z" />
    </Svg>
  );
}

export function ViewsIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 20v-6M10 20V9M15 20v-9M20 20V4" />
    </Svg>
  );
}

export function PlayIcon({ size = 28 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.500v13a.8.800 0 0 0 1.200.700l10.500-6.500a.8.800 0 0 0 0-1.400L9.200 4.800A.8.800 0 0 0 8 5.500Z" />
    </svg>
  );
}

export function PauseIcon({ size = 28 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6.500" y="5" width="4" height="14" rx="1" />
      <rect x="13.500" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

export function ClipIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="5.500" width="13" height="13" rx="2.500" />
      <path d="m16 10.500 5-3v9l-5-3" />
    </Svg>
  );
}

export function CloseIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function BackIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 12H5M11 5.500 4.500 12l6.500 6.500" />
    </Svg>
  );
}
