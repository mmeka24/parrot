/**
 * Sends the sign-in email.
 *
 * Production uses Resend (an HTTPS API; set RESEND_API_KEY and EMAIL_FROM).
 * Outside production, with no key, the link is printed to the server log so
 * sign-in can be tried locally. A link is NEVER logged in production: it is a
 * credential.
 */

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface Mailer {
  readonly kind: 'resend' | 'log';
  send(mail: Mail): Promise<void>;
}

export class ResendMailer implements Mailer {
  readonly kind = 'resend' as const;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(mail: Mail): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Status only: the body can echo the recipient.
      throw new Error(`email provider returned ${res.status}`);
    }
  }
}

/** Development only. */
export class LogMailer implements Mailer {
  readonly kind = 'log' as const;

  constructor(private readonly log: (line: string) => void = console.log) {}

  async send(mail: Mail): Promise<void> {
    this.log(`\n  [dev mail] to ${mail.to}\n  ${mail.text.split('\n').join('\n  ')}\n`);
  }
}

export function signInEmail(to: string, link: string, minutes: number): Mail {
  const text =
    `Sign in to Parrot:\n${link}\n\n` +
    `This link works once and expires in ${minutes} minutes. ` +
    `If you did not ask for it, you can ignore this email.`;
  const html =
    `<p>Sign in to Parrot:</p><p><a href="${link}">Sign in</a></p>` +
    `<p>This link works once and expires in ${minutes} minutes. ` +
    `If you did not ask for it, you can ignore this email.</p>`;
  return { to, subject: 'Your Parrot sign-in link', text, html };
}
