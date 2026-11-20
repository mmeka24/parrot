/**
 * THE VOCABULARY MAP - every user-facing string in Parrot lives here.
 *
 * Product rule: a creator or viewer must be able to finish the whole flow
 * without ever learning that a blockchain was involved. So these
 * words are banned from anything a normal person reads:
 *
 *   wallet -> balance / account        USDC -> dollars
 *   gas -> (never mentioned; we pay)   transaction -> receipt
 *   chain / blockchain -> (omitted)    hash -> receipt
 *   mint, token, crypto, web3, nonce, seed phrase -> (omitted)
 *
 * `copy` is enforced by test/copy.test.ts, which fails the build if a forbidden
 * word appears. `technicalCopy` is the documented exception: the judges-only
 * "Under the hood" page and the secondary "Verify on Arc" receipt links, where
 * being explicit is the point. Nothing in `technicalCopy` may be rendered on the
 * viewer, creator, or bot surfaces.
 *
 * Dynamic values use {placeholders} filled by `fill()`, which keeps every string
 * a static literal that the test can scan.
 */

/** Words that must never appear in `copy`. Matched case-insensitively on word boundaries. */
export const FORBIDDEN_WORDS = [
  'wallet',
  'usdc',
  'gas',
  'transaction',
  'transactions',
  'txn',
  'tx',
  'hash',
  'chain',
  'blockchain',
  'onchain',
  'on-chain',
  'crypto',
  'cryptocurrency',
  'web3',
  'token',
  'tokens',
  'mint',
  'gwei',
  'erc-20',
  'erc20',
  'smart contract',
  'private key',
  'seed phrase',
  'nonce',
  'ethereum',
  'evm',
  'rpc',
  'testnet',
  'mainnet',
  'faucet',
  'stablecoin',
  'settlement',
  'settle',
] as const;

export type ForbiddenWord = (typeof FORBIDDEN_WORDS)[number];

/** Fill {placeholders}. An unknown placeholder throws, so a missing value cannot ship to a user. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`copy placeholder {${key}} has no value in: ${template}`);
    }
    return String(value);
  });
}

export const copy = {
  brand: {
    name: 'Parrot',
    tagline: 'Get your videos seen in every language.',
    promise: 'Parrot pays for the dubs. You only pay for the views they bring.',
  },

  /** What Parrot says in replies under a post. */
  bot: {
    mention: '@parrot',
    planReply:
      'On it. Dubbing this into {languages}. Each one lands right here in this thread when it is ready.',
    singleReply: 'On it. Dubbing this into {language}. It lands right here when it is ready.',
    dubPost: '{flag} {nativeName} ({language}) - dubbed by Parrot. Watch: {link}',
    duplicateReply: 'Already dubbed this one into {language} -> {link}',
    declinedReply: 'I cannot dub this one: {reason}',
    declineReasonTooLong: 'the clip is longer than I can dub right now.',
    declineReasonTooShort: 'the clip is too short to dub.',
    declineReasonNoVideo: 'I could not find a video in that post.',
    declineReasonNotAuthor: 'only the person who posted the video can ask me to dub it.',
    declineReasonUnsupportedLanguage: 'I cannot dub into that language yet.',
    declineReasonNoBalance: 'your Parrot balance is empty. Add funds and ask me again.',
    declineReasonAlreadyDubbed: 'it is already dubbed into every language I would pick.',
    qcFailedReply:
      'The {language} dub did not come out well enough to publish, so I scrapped it. That one is on me, not you.',
    failedReply: 'The {language} dub did not finish. Nothing was charged to you.',
    errorReply: 'Something went wrong on my end. Try me again in a minute.',
    rateLimitedReply: 'I am a bit swamped right now - give me a few minutes and ask again.',
  },

  /** One dub's state, as a creator reads it. */
  status: {
    queued: 'Waiting',
    dubbing: 'Dubbing',
    qc: 'Checking quality',
    published: 'Live',
    rejectedByQc: 'Scrapped',
    failed: 'Did not finish',
  },

  /** Where a language stands for a creator. */
  language: {
    winner: 'Proven',
    testing: 'Testing',
    untested: 'Not tried',
    dropped: 'Dropped',
    roleWinner: 'Proven',
    roleTest: 'Trying',
    roleExplore: 'Exploring',
    modeExplore: 'Learning your audience',
    modeFocus: 'Dubbing what works',
  },

  /** Quality checks, by name. */
  qc: {
    duration_match: 'Same length as the original',
    language_detect: 'Spoken in the right language',
    audio_sanity: 'Clear, steady sound',
    back_translation: 'Says the same thing as the original',
    passed: 'Passed',
    failed: 'Failed',
    skipped: 'Not checked',
  },

  payment: {
    title: 'Paid for {views} views',
    detail: '{views} new views across {languages} at {price} per 1,000.',
    pending: 'Sending',
    confirmed: 'Paid',
    failed: 'Did not go through',
    verifyLink: 'Verify on Arc',
    testModeNote: 'Test mode. No real money moved.',
    demoBalanceNote: 'Demo balance. Sign in to pay from your own account.',
    simulatedViewsNote: 'For views generated by the demo audience.',
  },

  warnings: {
    lowBalance: 'Your balance is too low to cover new views. Add funds to keep your dubs counting.',
    valueBelowPrice:
      'At your rate a view is worth less than it costs ({value} against {price} per 1,000 views). Every dubbed view would lose you money.',
    budgetReached: 'This post reached its budget. Its dubs stay up and further views are free.',
  },

  errors: {
    genericTitle: 'That did not work',
    genericBody: 'Give it another try. If it keeps happening, it is on us, not you.',
    notFoundTitle: 'We cannot find that',
    notFoundBody: 'The link may be wrong, or it may have been taken down.',
    dubNotFoundTitle: 'We cannot find that dub',
    dubNotFoundBody: 'The link may be wrong, or the dub may have been taken down.',
    dubUnavailableTitle: 'This dub is not ready',
    dubUnavailableBody: 'It may still be rendering, or it did not pass our quality checks.',
    notSignedInTitle: 'Sign in to do that',
    notSignedInBody: 'This page belongs to someone. Sign in as them to change it.',
    notYoursTitle: 'This is not your page',
    notYoursBody: 'Only the creator can change these settings.',
    badAmountTitle: 'Check that amount',
    badAmountBody: 'Use a plain dollar amount, like 8 or 2.50.',
    noVideoTitle: 'There is no video in that post',
    noVideoBody: 'Parrot can only dub a post that has a video.',
    declinedTitle: 'Parrot cannot dub this one',
    handleTakenTitle: 'That name is taken',
    handleTakenBody: 'Someone else has already connected it. Pick the name you post under.',
    badHandleTitle: 'Check that name',
    badHandleBody: 'Use the name you post under: letters, numbers and underscores, up to 15.',
    demoClosedTitle: 'Not available here',
    demoClosedBody: 'The demo controls are switched off on this server.',
    rateLimitedTitle: 'One moment',
    rateLimitedBody: 'That is a lot very quickly. Give it a few seconds and try again.',
  },

  extension: {
    name: 'Parrot',
    tagline: 'Dubs for the videos in your timeline.',
    watchPrefix: 'Also in',
    watchChipTitle: 'Watch in {language}. Free.',
    dubCta: 'Dub this',
    dubCtaAnother: 'Dub to another language',
    menuTitle: 'Dub this video to',
    menuAuto: 'Let Parrot choose',
    menuNote: 'Parrot pays for the dub. You only pay for the views it brings.',
    menuEmpty: 'This video has been requested in every language Parrot speaks.',
    typing: 'Asking Parrot under your post...',
    pending: 'Parrot is working on it...',
    replyPrefix: 'Parrot',
    composerFailed: 'Could not open the reply box. Reply to your post with: {request}',
    offline: 'Parrot cannot be reached right now.',
    popupConnected: 'Connected',
    popupDisconnected: 'Not connected',
    popupServer: 'Parrot server',
    popupSave: 'Save',
    popupSaved: 'Saved.',
    popupTestMode: 'Test mode. Standing in for the real thing right now:',
    popupAllReal: 'Everything is running for real.',
    popupDashboard: 'Open Parrot',
    popupActiveOn: 'Active on',
    notDubbedYet: 'No dub yet',
    pageSourceNote: 'On X, Parrot reads the likes and views from this page. It cannot check them.',
    requestFailed: 'Parrot could not take that request. {detail}',
    notAuthor: 'Only the person who posted the video can ask for a dub.',
  },

  demo: {
    badge: 'Test mode',
    simulatedBadge: 'Simulated',
    audienceCta: 'Send a demo audience',
    audienceRunning: 'Audience arriving...',
    audienceNote:
      'A demo audience is generated so you can see the numbers move. Those views are labelled simulated.',
  },
} as const;

/**
 * Judges-only strings. EXEMPT from the forbidden-word test by design, and never
 * rendered on the creator, viewer or bot surfaces. The "Under the hood" page
 * exists so technically-minded people can check our work.
 */
export const technicalCopy = {
  underTheHoodTitle: 'Under the hood',
  underTheHoodSubtitle: 'For judges and the curious: exactly what is on-chain and what is not.',
  chainLabel: 'Arc testnet',
  explorerCta: 'Open in the Arc explorer',
  offChainCostNote:
    'The ElevenLabs dubbing bill is paid off-chain in fiat and recorded as a cost against Parrot.',
  custodialNote:
    'Accounts are custodial in test mode: each creator gets an Arc wallet whose key Parrot holds, encrypted.',
  gasNote: 'Arc charges network fees in USDC, so a creator holds one balance and it covers everything.',
} as const;

export type Copy = typeof copy;
