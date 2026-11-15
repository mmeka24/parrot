import type { Metadata, Viewport } from 'next';
import { copy } from '@parrot/shared';
import { getSystemStatus } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';
import { ServiceWorker, SimulatedBanner, SiteFooter, SiteHeader } from '@/components/SiteChrome';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: {
    default: copy.brand.name + ' — ' + copy.brand.tagline,
    template: '%s — ' + copy.brand.name,
  },
  description: copy.brand.creatorTagline,
  manifest: '/manifest.webmanifest',
  applicationName: copy.brand.name,
  appleWebApp: { capable: true, title: copy.brand.name, statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fdf7ef' },
    { media: '(prefers-color-scheme: dark)', color: '#14130f' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { data: status } = await getSystemStatus();

  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          {localCopy.nav.skipToContent}
        </a>
        <SimulatedBanner items={status.mocked} />
        <SiteHeader status={status} />
        <main id="main" className="shell" style={{ paddingBlock: '1.75rem 3rem' }}>
          {children}
        </main>
        <SiteFooter />
        <ServiceWorker />
      </body>
    </html>
  );
}
