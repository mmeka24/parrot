/**
 * The public address of the web app.
 *
 * Link previews (Open Graph / X cards) must use absolute URLs, because the
 * crawler that unfurls a link has no idea where a relative "/dub/x.png" lives.
 * In production set NEXT_PUBLIC_SITE_URL to the deployed origin.
 */
export const siteUrl = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? process.env.PUBLIC_WEB_URL ?? 'http://localhost:3100',
);

/** Where the timeline lives: the local stand-in in development, X otherwise. */
export const timelineUrl = (process.env.NEXT_PUBLIC_XCLONE_URL ?? 'http://localhost:3200').replace(/\/$/, '');
