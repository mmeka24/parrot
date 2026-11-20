/**
 * Strings this app needed that do not exist in `@parrot/shared`'s `copy` map.
 *
 * Navigation labels and sign-in copy: all of them user-facing, all of them
 * written to the same vocabulary rule as copy.ts. Nothing in this file may
 * contain a forbidden word.
 */

export const localCopy = {
  nav: {
    home: 'Home',
    dashboard: 'My dashboard',
    demo: 'Demo creators',
    underTheHood: 'Under the hood',
    extension: 'Get the extension',
    menu: 'Menu',
    close: 'Close',
    skipToContent: 'Skip to content',
  },

  account: {
    signIn: 'Sign in',
    signOut: 'Sign out',
    signInTitle: 'Sign in to Parrot',
    signInIntro: 'One tap and you are in. A new account starts with {bonus} to pay for your first views.',
    google: 'Continue with Google',
    or: 'or',
    emailLabel: 'Email',
    emailPlaceholder: 'you@example.com',
    emailCta: 'Email me a sign-in link',
    emailSending: 'Sending...',
    checkEmailTitle: 'Check your email',
    checkEmailBody: 'We sent a sign-in link to {email}. It works once and lasts 15 minutes.',
    useDifferent: 'Use a different email',
    verifyingTitle: 'Signing you in...',
    verifiedTitle: 'You are in',
    verifiedNew: 'Your account is ready, with {bonus} to start.',
    verifiedBack: 'Welcome back.',
    verifyFailedTitle: 'That link did not work',
    verifyFailedBody: 'It may have expired or been used already. Ask for a new one.',
    newLink: 'Get a new link',
    googleFailed: 'Google sign-in did not work. Try again, or use email.',
    googleUnavailable: 'Google sign-in is not set up yet. Use email instead.',
    unavailable: 'Sign-in is not available right now.',
    balance: 'Balance',
    settingUp: 'Setting up your balance...',
  },

  shell: {
    simulatedBannerTitle: 'What is simulated right now',
    simulatedBannerDismiss: 'Got it',
    footerTagline: 'Get your videos seen in every language.',
    footerNote: 'Built for UBC 26. Test mode: no real money moves.',
  },
} as const;
