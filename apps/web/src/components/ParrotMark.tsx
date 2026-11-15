/**
 * The brand mark. Hand-drawn inline SVG, never an emoji: a parrot head in
 * profile with a mango beak, so it reads at 20px in the header and at 120px on
 * the landing page.
 */
export function ParrotMark({ size = 32, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {/* head */}
      <path
        d="M41 10c-11.5 0-20.5 8.4-20.5 19.6 0 6.2 2.6 11 6.4 14.8C31 48.5 33 52.3 33 56h12c0-5 1.7-8.2 4.6-11.4C53.9 39.8 57 34.6 57 28.4 57 17.8 51.6 10 41 10Z"
        fill="var(--teal)"
      />
      {/* crest */}
      <path
        d="M43 10c1-4.2-.6-7.4-4.6-9.2 1.2 3.4.5 5.8-2.1 7.2-1.4-3.2-4-4.8-7.6-4.8 2.2 2.6 2.9 5 2.1 7.3C33.9 9.2 37.4 8.9 43 10Z"
        fill="var(--mango)"
      />
      {/* cheek */}
      <path
        d="M27 30.5c0-5.8 4.3-10 10.3-10 2.2 0 4 .5 5.5 1.4-1.6 6-6 10.6-12.2 12.2-2.3.6-3.6-1-3.6-3.6Z"
        fill="var(--teal-wash)"
        opacity="0.55"
      />
      {/* eye */}
      <circle cx="37" cy="26" r="4.6" fill="var(--paper-raised)" />
      <circle cx="38.2" cy="26.4" r="2.4" fill="var(--ink)" />
      {/* beak */}
      <path
        d="M24 24.5c-6.6 1.3-11.4 5-14 11.2 4.6-.7 7.6.2 9.3 2.6 1.4 2 3.9 2.3 5.9.8 2.5-1.9 3.8-5.2 3.8-9.6 0-3.3-1.7-5.4-5-5Z"
        fill="var(--mango)"
      />
      <path
        d="M19.3 38.3c1.4 2 3.9 2.3 5.9.8 1-.8 1.9-1.9 2.5-3.3-3.2 1.2-6 1.9-8.4 2.5Z"
        fill="var(--mango-deep)"
      />
      {/* chest feathers */}
      <path
        d="M34 46c2.6 1.6 6.4 1.6 9.6 0-.6 3-1 5.6-1 10h-7.3c0-4.2-.4-7-1.3-10Z"
        fill="var(--berry)"
        opacity="0.75"
      />
      {/* perch */}
      <rect x="26" y="56" width="26" height="4.5" rx="2.25" fill="var(--ink)" opacity="0.18" />
    </svg>
  );
}
