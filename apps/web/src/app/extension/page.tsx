import type { Metadata } from 'next';
import { copy } from '@parrot/shared';
import { Panel } from '@/components/ui';

export const metadata: Metadata = { title: 'Get the extension' };

const ZIP = '/parrot-extension.zip';

export default function ExtensionPage() {
  return (
    <div className="stack" style={{ maxWidth: '44rem' }}>
      <div>
        <p className="eyebrow">Browser extension</p>
        <h1 style={{ margin: '0.25rem 0 0.5rem' }}>Watch in your language, right on X</h1>
        <p style={{ color: 'var(--ink-soft)' }}>
          {copy.brand.name} adds a small strip under every video post. Anyone can see which
          languages a video is already available in. If the video is yours, one click asks for a
          new dub. Parrot pays to make it; you only pay for the views it brings.
        </p>
      </div>

      <Panel title="Download">
        <p style={{ marginTop: 0 }}>
          <a className="btn btn-primary" href={ZIP} download>
            Download for Chrome
          </a>
        </p>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9rem', marginBottom: 0 }}>
          Works in Chrome, Edge, Brave and other Chromium browsers. It is not in the Chrome Web
          Store yet, so it installs by hand. That takes about a minute.
        </p>
      </Panel>

      <Panel title="Install it">
        <ol style={{ paddingLeft: '1.25rem', margin: 0, display: 'grid', gap: '0.6rem' }}>
          <li>Download the file above and unzip it. You get a folder called parrot-extension.</li>
          <li>
            Open <code>chrome://extensions</code> in your browser and switch on{' '}
            <strong>Developer mode</strong> (top right).
          </li>
          <li>
            Click <strong>Load unpacked</strong> and choose the unzipped folder.
          </li>
          <li>
            Open <code>x.com</code> and find a video. Look for the {copy.brand.name} strip under it.
          </li>
        </ol>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9rem', marginBottom: 0 }}>
          Keep the folder where it is. Chrome reads the extension from it each time it starts.
        </p>
      </Panel>

      <Panel title="Good to know">
        <ul style={{ paddingLeft: '1.25rem', margin: 0, display: 'grid', gap: '0.5rem' }}>
          <li>
            It never posts to X for you. Asking for a dub goes straight to {copy.brand.name}.
          </li>
          <li>Only the person who posted a video can ask for it to be dubbed.</li>
          <li>
            Numbers on the strip, like likes and length, are read from the page you are on and
            are not checked.
          </li>
          <li>This is an early version and has not been tested on every part of x.com.</li>
        </ul>
      </Panel>
    </div>
  );
}
