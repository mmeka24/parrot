/**
 * THE VOCABULARY MAP - every user-facing string in Parrot lives here.
 *
 * Non-negotiable product rule: a creator or viewer must be able to finish the
 * whole flow without ever learning that a blockchain was involved. So these
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
  'ledger',
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
    tagline: 'Watch anything in your language.',
    creatorTagline: 'Your videos, everywhere, for free.',
  },

  viewer: {
    previewBadge: 'Free preview',
    previewEndedTitle: 'Want the rest?',
    previewEndedBody: 'Unlock the full dub and watch it straight through.',
    unlockCta: 'Unlock for {price}',
    unlockingCta: 'Unlocking...',
    unlockedTitle: 'Squawk! You are in.',
    unlockedBody: 'Enjoy - this one is yours to rewatch any time.',
    dubbedInto: 'Dubbed into {language}',
    originalLanguage: 'Originally in {language}',
    starterCreditTitle: 'Test mode: {amount} free credit',
    starterCreditBody: 'No real money. This is a demo account we topped up for you.',
    balanceLabel: 'Your balance',
    balanceAfter: '{amount} left',
    rewatchCta: 'Watch again',
    shareCta: 'Share',
    shareCopied: 'Link copied',
    cardSoon: 'Card and Apple Pay coming soon',
    howItWorksTitle: 'How is this free for the creator?',
    howItWorksBody:
      'Parrot pays to dub the video up front and earns it back a few cents at a time. The creator keeps the bigger share.',
    poweredBy: 'Dubbed by Parrot',
  },

  creator: {
    dashboardTitle: 'Your earnings',
    totalEarned: 'Earned so far',
    pendingLabel: 'Ready to claim',
    paidOutLabel: 'Already paid out',
    perDubViews: '{count} views',
    perDubUnlocks: '{count} unlocks',
    perDubEarned: '{amount} earned',
    claimCta: 'Claim {amount}',
    claimingCta: 'Sending...',
    claimedTitle: 'On its way',
    claimedBody: 'We sent {amount} to your account. It usually lands in a few seconds.',
    claimEmptyTitle: 'Nothing to claim yet',
    claimEmptyBody: 'As soon as someone unlocks one of your dubs, your earnings show up here.',
    signInPrompt: 'Sign in to claim',
    signInBody: 'Use the account you posted from, or an email. It takes one tap.',
    earningsWaiting: 'We are holding {amount} for you.',
    explainerTitle: 'How you get paid',
    explainerBody:
      'Parrot covers the cost of dubbing your video. Every time someone unlocks the dub, you keep {creatorShare} of what they pay.',
    noDubsTitle: 'No dubs yet',
    noDubsBody: 'Reply to one of your posts with "{mention} dub this to Spanish" to get started.',
  },

  bot: {
    mention: '@parrot',
    acceptedReply:
      'Squawk! On it - dubbing this into {language} now. Your link lands here in about a minute.',
    publishedReply: 'Your {language} dub is live -> {link} - you earn every time someone watches it.',
    duplicateReply: 'Already dubbed this one into {language} -> {link} - share away.',
    declinedReply:
      'Passing on this one for now: {reason} Reply again once that changes and I will take another look.',
    declineReasonLowSignal: 'not enough interest yet to cover the cost of dubbing it.',
    declineReasonTooLong: 'the clip is longer than I can afford to dub right now.',
    declineReasonBudget: 'I am low on funds today and keeping a reserve.',
    declineReasonNoVideo: 'I could not find a video in that post.',
    declineReasonNotAuthor: 'only the person who posted the video can ask me to dub it.',
    declineReasonUnsupportedLanguage: 'I cannot dub into that language yet.',
    qcFailedReply:
      'The dub did not come out well enough to publish, so I scrapped it. No cost to you - I will try again if you ask.',
    firstUnlockReply: 'Someone just watched your {language} dub. You earned {amount}.',
    dailySummaryReply: 'Your {language} dub earned {amount} from {count} viewers today.',
    statusReply: 'That one is {status}. {detail}',
    errorReply: 'Something went wrong on my end. Try me again in a minute.',
    rateLimitedReply: 'I am a bit swamped right now - give me a few minutes and ask again.',
  },

  status: {
    requested: 'just came in',
    parsed: 'being read',
    evaluating: 'being weighed up',
    declined: 'passed on',
    approved: 'approved',
    dubbing: 'being dubbed',
    qc: 'in final checks',
    rejectedByQc: 'scrapped in checks',
    published: 'live',
    earning: 'live and earning',
    settled: 'paid out',
    failed: 'stalled',
  },

  receipt: {
    drawerTitle: 'Receipt',
    unlockPaid: 'Unlock paid',
    unlockPaidDetail: 'You paid {amount} to watch this in {language}.',
    creatorSharePaid: 'Creator share sent',
    creatorSharePaidDetail: '{amount} went to {handle}.',
    parrotSharePaid: 'Parrot share',
    parrotSharePaidDetail: '{amount} went back to Parrot to cover the dub.',
    payoutSent: 'Payout sent',
    payoutSentDetail: '{amount} sent to your account.',
    dubCost: 'Dubbing cost',
    dubCostDetail: 'Parrot paid {amount} to dub this video.',
    pending: 'Sending...',
    timestamp: 'on {date}',
    verifyLink: 'Verify on Arc',
    verifyHint: 'Opens a public record of this payment.',
  },

  errors: {
    genericTitle: 'That did not work',
    genericBody: 'Give it another try. If it keeps happening, it is on us, not you.',
    retryCta: 'Try again',
    backCta: 'Go back',
    paymentFailedTitle: 'The unlock did not go through',
    paymentFailedBody: 'You have not been charged. Tap to try once more.',
    insufficientBalanceTitle: 'Not enough credit',
    insufficientBalanceBody: 'Your test credit has run out. In the real thing you would top up here.',
    dubUnavailableTitle: 'This dub is not ready',
    dubUnavailableBody: 'It may still be rendering, or it did not pass our quality checks.',
    dubNotFoundTitle: 'We cannot find that dub',
    dubNotFoundBody: 'The link may be wrong, or the dub may have been taken down.',
    dubbingFailedTitle: 'The dub did not come out right',
    dubbingFailedBody:
      'We scrapped it rather than publish something bad. Nothing was charged to the creator.',
    videoSourceTitle: 'We could not read that post',
    videoSourceBody: 'Check that the post is public and has a video in it.',
    offlineTitle: 'You are offline',
    offlineBody: 'Reconnect and we will pick up where you left off.',
    sourceUnavailableTitle: 'We cannot reach that service right now',
    sourceUnavailableBody: 'It is a temporary outage. We will keep trying in the background.',
    notSignedInTitle: 'Sign in to see this',
    notSignedInBody: 'One tap with your email or the account you posted from.',
  },

  demo: {
    badge: 'Test mode',
    simulatedBadge: 'Simulated traffic',
    simulatedNote:
      'These viewers are generated for the demo. The payments they make are real test-mode payments.',
    seedCta: 'Seed demo data',
    startTrafficCta: 'Start simulated traffic',
    stopTrafficCta: 'Stop simulated traffic',
    compressedTimeNote: 'Demo mode: a day of results is compressed into a minute.',
  },
} as const;

/**
 * Judges-only and receipt-footer strings. EXEMPT from the forbidden-word test by
 * design, and never rendered on the viewer, creator, or bot surfaces. The
 * "Under the hood" page exists so technically-minded people can check our work.
 */
export const technicalCopy = {
  underTheHoodTitle: 'Under the hood',
  underTheHoodSubtitle: 'For judges and the curious: exactly what is on-chain and what is not.',
  chainLabel: 'Arc testnet',
  explorerCta: 'Open in the Arc explorer',
  latestBlock: 'Latest block',
  streamLive: 'QuickNode Stream live',
  streamStale: 'QuickNode Stream stale - falling back to polling',
  gatewayBatched: 'Unlocks are batched off-chain by Circle Gateway, then settled on-chain.',
  offChainCostNote:
    'The ElevenLabs dubbing bill is paid off-chain in fiat and mirrored as a ledger debit.',
  custodialNote: 'Test-mode accounts are custodial: keys are held by the Parrot backend.',
} as const;

export type Copy = typeof copy;
