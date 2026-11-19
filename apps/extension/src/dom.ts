/**
 * Small DOM helpers. Everything the extension draws is built with these, never
 * with innerHTML: post text and Parrot's replies come from other people, and a
 * string pasted into markup is how a page gets script injected into it.
 */

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | undefined> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG built from [tag, attributes] pairs. Static shapes only. */
export function svg(
  size: number,
  viewBox: string,
  shapes: ReadonlyArray<readonly [string, Record<string, string>]>,
): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('width', String(size));
  root.setAttribute('height', String(size));
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    root.append(shape);
  }
  return root;
}

/** The Parrot head, reduced to what still reads at 16px. Same shapes as the web app's mark. */
export function parrotMark(size: number): SVGSVGElement {
  return svg(size, '0 0 64 64', [
    [
      'path',
      {
        d: 'M41 10c-11.5 0-20.5 8.4-20.5 19.6 0 6.2 2.6 11 6.4 14.8C31 48.5 33 52.3 33 56h12c0-5 1.7-8.2 4.6-11.4C53.9 39.8 57 34.6 57 28.4 57 17.8 51.6 10 41 10Z',
        fill: 'var(--p-teal)',
      },
    ],
    [
      'path',
      {
        d: 'M43 10c1-4.2-.6-7.4-4.6-9.2 1.2 3.4.5 5.8-2.1 7.2-1.4-3.2-4-4.8-7.6-4.8 2.2 2.6 2.9 5 2.1 7.3C33.9 9.2 37.4 8.9 43 10Z',
        fill: 'var(--p-mango)',
      },
    ],
    ['circle', { cx: '37', cy: '26', r: '4.6', fill: '#fffdfa' }],
    ['circle', { cx: '38.2', cy: '26.4', r: '2.4', fill: '#1b1a17' }],
    [
      'path',
      {
        d: 'M24 24.5c-6.6 1.3-11.4 5-14 11.2 4.6-.7 7.6.2 9.3 2.6 1.4 2 3.9 2.3 5.9.8 2.5-1.9 3.8-5.2 3.8-9.6 0-3.3-1.7-5.4-5-5Z',
        fill: 'var(--p-mango)',
      },
    ],
  ]);
}

/** Resolve once `test` returns something truthy, or null after `timeoutMs`. */
export function waitFor<T>(test: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = (): void => {
      const value = test();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return resolve(null);
      window.setTimeout(poll, 50);
    };
    poll();
  });
}
