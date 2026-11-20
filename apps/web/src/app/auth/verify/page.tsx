import type { Metadata } from 'next';
import { VerifySignIn } from '@/components/VerifySignIn';

// The address carries a one-time secret: never send it onward in a Referer header.
export const metadata: Metadata = { title: 'Signing in', referrer: 'no-referrer' };

export default function VerifyPage() {
  return <VerifySignIn />;
}
