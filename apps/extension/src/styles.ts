/**
 * The strip's stylesheet. It lives in a shadow root, so the host page's CSS
 * cannot reach in and this cannot leak out - the strip looks the same on any
 * timeline, and the timeline looks the same with or without it.
 *
 * Parrot's own colours (mango and teal, from apps/web), not the host's blue:
 * what Parrot adds to a page should be recognisable as Parrot's.
 */
export const STRIP_CSS = `
:host {
  all: initial;
  display: block;
  --p-ink: #1b1a17;
  --p-soft: #5d574c;
  --p-rule: #e6d9c4;
  --p-wash: #fdf7ef;
  --p-mango: #f26a1b;
  --p-mango-deep: #c84f07;
  --p-mango-wash: #fdeadc;
  --p-teal: #0f7a6c;
  --p-teal-wash: #d9efe9;
  --p-bad: #b32a3f;
  --p-on-accent: #fffdfa;
  --p-focus: #2b5fd9;
}
@media (prefers-color-scheme: dark) {
  :host {
    --p-ink: #f6efe3;
    --p-soft: #bdb3a1;
    --p-rule: #403a2f;
    --p-wash: #1d1b16;
    --p-mango: #ff8a3d;
    --p-mango-deep: #ffa566;
    --p-mango-wash: #30200f;
    --p-teal: #4fd1b9;
    --p-teal-wash: #0f2a26;
    --p-bad: #ff8095;
    --p-on-accent: #17120b;
    --p-focus: #9bb8ff;
  }
}
* { box-sizing: border-box; }
.strip {
  margin-top: 10px;
  font: 13px/18px ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif;
  color: var(--p-ink);
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 700;
  color: var(--p-soft);
}
.label { color: var(--p-soft); }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px 0 8px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: var(--p-teal-wash);
  color: var(--p-teal);
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}
.chip:hover { border-color: var(--p-teal); }
.chip .tri {
  width: 0; height: 0;
  border-left: 7px solid currentColor;
  border-top: 4.5px solid transparent;
  border-bottom: 4.5px solid transparent;
}
.spacer { flex: 1 1 auto; }
button {
  font: inherit;
  cursor: pointer;
}
.cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  border: 0;
  background: var(--p-mango);
  color: var(--p-on-accent);
  font-weight: 700;
}
.cta:hover { background: var(--p-mango-deep); }
.cta[aria-expanded="true"] { background: var(--p-mango-deep); }
.cta:disabled { opacity: 0.6; cursor: default; }
.caret {
  width: 0; height: 0;
  border-top: 5px solid currentColor;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
}
.pending {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--p-mango-deep);
  font-weight: 600;
}
.dot {
  width: 7px; height: 7px; border-radius: 999px;
  background: var(--p-mango);
  animation: pulse 1.1s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: 0.25; } }
.menu {
  margin-top: 8px;
  padding: 10px 12px 12px;
  border-radius: 14px;
  border: 1px solid var(--p-rule);
  background: var(--p-wash);
}
.menu-title { font-weight: 700; margin: 0 0 8px; }
.langs { display: flex; flex-wrap: wrap; gap: 6px; }
.lang {
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--p-rule);
  background: transparent;
  color: var(--p-ink);
  font-weight: 600;
}
.lang:hover { border-color: var(--p-mango); background: var(--p-mango-wash); }
.note { margin: 10px 0 0; color: var(--p-soft); }
.reply {
  margin: 8px 0 0;
  padding-left: 10px;
  border-left: 3px solid var(--p-rule);
  color: var(--p-soft);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.reply b { color: var(--p-ink); }
.status { margin: 8px 0 0; color: var(--p-soft); }
.status.error { color: var(--p-bad); }
a:focus-visible, button:focus-visible {
  outline: 2px solid var(--p-focus);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .dot { animation: none; }
}
`;
