/**
 * Offline fixtures.
 *
 * The backend is built in parallel, so every screen must be fully browsable
 * with nothing running. These fixtures tell one coherent story:
 *
 *   @maya_builds posts a 30s clip. Parrot predicts 2,000 Spanish views at a
 *   12.5% unlock rate, takes 40% of each $0.02 unlock, discounts by a 70%
 *   chance the dub passes quality checks, and compares that with the $0.40 it
 *   costs to dub:  0.70 x $2.00 - $0.40 = +$1.00 expected. It dubs.
 *   247 people unlocked it. Parrot made $1.58, Maya made $2.96.
 *
 * Plus the two failure shapes a judge will ask about: one job Parrot passed on
 * because the maths did not work, and one it paid for and then scrapped in
 * quality checks, booked honestly as a loss.
 */

import type {
  AccuracyPointDto,
  AgentDashboardDto,
  AgentJobRowDto,
  AgentSummaryDto,
  BotConsoleDto,
  CreatorDashboardDto,
  DecisionLogEntryDto,
  DemoStateDto,
  DubPageDto,
  FeedStatusDto,
  ReceiptDto,
  SystemStatusDto,
  TickerEntryDto,
} from '@parrot/shared';
import { ARC_TESTNET, GATEWAY_WALLET_ADDRESS, USDC_ADDRESS, addressUrl, txUrl } from '@parrot/shared';
import { money } from './money';

const SAMPLE_TX = [
  '0x9f2c1d4ab7e35908c6b1de2f4a7c05318e9d6b240f7a1c8e35b9d0472a6e1c53',
  '0x41b8e07d2c9a6f35481de0b7c2a95f6301d847ea9b2c0f35861d7ae4902bc117',
  '0xc70d5a19e4b82f6035d1ac79b240e85f1397d6ba0c58e241f93b07ad6e125c48',
  '0x2ae91c7b05d348f61927ea0cb4d7538e60fa19c23b85d470e1a9c6fb38200d75',
];

const tx = (i: number): string => txUrl(SAMPLE_TX[i % SAMPLE_TX.length] ?? SAMPLE_TX[0]!);

/** Fixed timestamps keep server and client renders identical (no hydration drift). */
const T0 = Date.parse('2026-11-15T17:04:00.000Z');
const at = (minutesAgo: number): string => new Date(T0 - minutesAgo * 60_000).toISOString();

// ---------------------------------------------------------------------------
// System status
// ---------------------------------------------------------------------------

export const systemStatus: SystemStatusDto = {
  demoMode: true,
  network: ARC_TESTNET.name,
  explorerUrl: ARC_TESTNET.explorerUrl,
  capabilities: {
    onchainSettlement: true,
    x402Payments: true,
    dubbing: true,
    qcLanguageDetection: true,
    xApi: false,
    grokParsing: false,
    quicknodeStream: true,
  },
  mocked: [
    'Posts and replies come from a built-in timeline, not a live social feed.',
    'Viewers are generated for the demo, so the view counts are invented.',
    'Everything is spent in play money we topped up for the demo.',
  ],
  addresses: {
    usdc: USDC_ADDRESS,
    gatewayWallet: GATEWAY_WALLET_ADDRESS,
    revenue: '0x5A41bD8e7c9F02346D1Ab7059e23Cf6184a0D379',
    treasury: '0x8Bc03E7146aD95f20bE4719c3D8a1fE0b25C47aa',
  },
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

const dubReceipts: readonly ReceiptDto[] = [
  {
    id: 'rcpt_unlock_1',
    title: 'Unlock paid',
    detail: 'You paid $0.02 to watch this in Spanish.',
    amount: money('20000', '$0.02'),
    at: at(2),
    status: 'confirmed',
    verifyUrl: tx(0),
    simulated: false,
  },
  {
    id: 'rcpt_creator_1',
    title: 'Creator share sent',
    detail: '$0.012 went to @maya_builds.',
    amount: money('12000', '$0.012'),
    at: at(2),
    status: 'confirmed',
    verifyUrl: tx(1),
    simulated: false,
  },
  {
    id: 'rcpt_parrot_1',
    title: 'Parrot share',
    detail: '$0.008 went back to Parrot to cover the dub.',
    amount: money('8000', '$0.008'),
    at: at(2),
    status: 'confirmed',
    verifyUrl: tx(1),
    simulated: false,
  },
  {
    id: 'rcpt_dubcost_1',
    title: 'Dubbing cost',
    detail: 'Parrot paid $0.40 to dub this video.',
    amount: money('400000', '$0.40'),
    at: at(214),
    status: 'confirmed',
    verifyUrl: null,
    simulated: true,
  },
];

// ---------------------------------------------------------------------------
// Dub pages
// ---------------------------------------------------------------------------

const PREVIEW_MEDIA =
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

const heroDub: DubPageDto = {
  jobId: 'dub_es_7hq2',
  state: 'EARNING',
  targetLang: 'es',
  targetLanguageName: 'Spanish',
  sourceLanguageName: 'English',
  creator: { handle: 'maya_builds', displayName: 'Maya Okonjo' },
  sourceUrl: 'https://x.com/maya_builds/status/1860042215577',
  durationS: 30,
  posterUrl: '/posters/es.svg',
  previewUrl: PREVIEW_MEDIA,
  fullUrl: null,
  previewSeconds: 8,
  price: money('20000', '$0.02'),
  unlocked: false,
  unlockCount: 247,
  viewCount: 1840,
  viewerBalance: money('1000000', '$1.00'),
  receipts: dubReceipts,
  simulated: true,
};

const ptDub: DubPageDto = {
  ...heroDub,
  jobId: 'dub_pt_4k19',
  targetLang: 'pt',
  targetLanguageName: 'Portuguese',
  posterUrl: '/posters/pt.svg',
  unlockCount: 96,
  viewCount: 702,
};

const qcRejectedDub: DubPageDto = {
  ...heroDub,
  jobId: 'dub_ja_9m30',
  state: 'REJECTED_BY_QC',
  targetLang: 'ja',
  targetLanguageName: 'Japanese',
  creator: { handle: 'dev_tiana', displayName: 'Tiana Reyes' },
  posterUrl: '/posters/ja.svg',
  previewUrl: null,
  fullUrl: null,
  unlockCount: 0,
  viewCount: 0,
  receipts: [],
};

const dubbingDub: DubPageDto = {
  ...heroDub,
  jobId: 'dub_hi_2b57',
  state: 'DUBBING',
  targetLang: 'hi',
  targetLanguageName: 'Hindi',
  creator: { handle: 'arjun.codes', displayName: 'Arjun Mehta' },
  posterUrl: '/posters/hi.svg',
  previewUrl: null,
  unlockCount: 0,
  viewCount: 0,
  receipts: [],
};

const dubsById: Readonly<Record<string, DubPageDto>> = {
  [heroDub.jobId]: heroDub,
  [ptDub.jobId]: ptDub,
  [qcRejectedDub.jobId]: qcRejectedDub,
  [dubbingDub.jobId]: dubbingDub,
};

/** Unknown ids resolve to the hero dub, so every link in the demo works. */
export function dubPage(id: string): DubPageDto {
  const found = dubsById[id];
  if (found) return found;
  return { ...heroDub, jobId: id };
}

export const heroDubId = heroDub.jobId;
export const sampleDubIds = [heroDub.jobId, ptDub.jobId, dubbingDub.jobId, qcRejectedDub.jobId];

// ---------------------------------------------------------------------------
// Creator dashboard
// ---------------------------------------------------------------------------

export function creatorDashboard(handle: string): CreatorDashboardDto {
  const clean = handle.replace(/^@/, '');
  const isMaya = clean.toLowerCase() === 'maya_builds';
  return {
    handle: clean,
    displayName: isMaya ? 'Maya Okonjo' : clean,
    signedIn: true,
    totalEarned: money('4112000', '$4.11'),
    readyToClaim: money('2964000', '$2.96'),
    paidOut: money('1148000', '$1.15'),
    creatorSharePercent: '60',
    dubs: [
      {
        jobId: heroDub.jobId,
        targetLanguageName: 'Spanish',
        state: 'EARNING',
        statusLabel: 'live and earning',
        views: 1840,
        unlocks: 247,
        earned: money('2964000', '$2.96'),
        publishedAt: at(212),
        dubPath: '/dub/' + heroDub.jobId,
      },
      {
        jobId: ptDub.jobId,
        targetLanguageName: 'Portuguese',
        state: 'SETTLED',
        statusLabel: 'paid out',
        views: 702,
        unlocks: 96,
        earned: money('1152000', '$1.15'),
        publishedAt: at(1460),
        dubPath: '/dub/' + ptDub.jobId,
      },
      {
        jobId: dubbingDub.jobId,
        targetLanguageName: 'Hindi',
        state: 'DUBBING',
        statusLabel: 'being dubbed',
        views: 0,
        unlocks: 0,
        earned: money('0', '$0.00'),
        publishedAt: null,
        dubPath: '/dub/' + dubbingDub.jobId,
      },
      {
        jobId: 'dub_ko_1f08',
        targetLanguageName: 'Korean',
        state: 'DECLINED',
        statusLabel: 'passed on',
        views: 0,
        unlocks: 0,
        earned: money('0', '$0.00'),
        publishedAt: null,
        dubPath: '/dub/dub_ko_1f08',
      },
    ],
    receipts: [
      {
        id: 'rcpt_payout_1',
        title: 'Payout sent',
        detail: '$1.15 sent to your account.',
        amount: money('1148000', '$1.15'),
        at: at(1430),
        status: 'confirmed',
        verifyUrl: tx(2),
        simulated: false,
      },
      {
        id: 'rcpt_creator_bulk',
        title: 'Creator share sent',
        detail: '$2.96 went to @maya_builds.',
        amount: money('2964000', '$2.96'),
        at: at(4),
        status: 'pending',
        verifyUrl: null,
        simulated: false,
      },
    ],
  };
}

/** A creator with nothing yet, so the empty state is reachable in the demo. */
export function emptyCreatorDashboard(handle: string): CreatorDashboardDto {
  const clean = handle.replace(/^@/, '');
  return {
    handle: clean,
    displayName: clean,
    signedIn: true,
    totalEarned: money('0', '$0.00'),
    readyToClaim: money('0', '$0.00'),
    paidOut: money('0', '$0.00'),
    creatorSharePercent: '60',
    dubs: [],
    receipts: [],
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const agents: readonly AgentSummaryDto[] = [
  {
    id: 'agent_scout',
    name: 'Scout',
    persona: 'Balanced. Backs a clip when the maths clears its margin, and says why when it passes.',
    balance: money('7421000', '$7.42'),
    lifetimeSpend: money('3150000', '$3.15'),
    lifetimeRevenue: money('4986000', '$4.99'),
    profit: money('1836000', '$1.84'),
    roiPercent: '58.3',
    jobsWon: 9,
    jobsDeclined: 4,
    qcPassRate: '88.9',
    predictionErrorPercent: '14.2',
    walletAddress: '0x5A41bD8e7c9F02346D1Ab7059e23Cf6184a0D379',
    verifyUrl: addressUrl('0x5A41bD8e7c9F02346D1Ab7059e23Cf6184a0D379'),
  },
  {
    id: 'agent_magpie',
    name: 'Magpie',
    persona: 'Greedy. Dubs almost anything that moves and eats the odd scrapped job as a cost of doing business.',
    balance: money('4108000', '$4.11'),
    lifetimeSpend: money('6240000', '$6.24'),
    lifetimeRevenue: money('7012000', '$7.01'),
    profit: money('772000', '$0.77'),
    roiPercent: '12.4',
    jobsWon: 17,
    jobsDeclined: 1,
    qcPassRate: '70.6',
    predictionErrorPercent: '31.8',
    walletAddress: '0x3Fd71aC09e4B8250913bEa7c6d4F05821bA9e3C6',
    verifyUrl: addressUrl('0x3Fd71aC09e4B8250913bEa7c6d4F05821bA9e3C6'),
  },
  {
    id: 'agent_owl',
    name: 'Owl',
    persona: 'Picky. Waits for a clip with real international pull, then bets bigger than anyone else.',
    balance: money('9630000', '$9.63'),
    lifetimeSpend: money('1800000', '$1.80'),
    lifetimeRevenue: money('3240000', '$3.24'),
    profit: money('1440000', '$1.44'),
    roiPercent: '80.0',
    jobsWon: 4,
    jobsDeclined: 11,
    qcPassRate: '100',
    predictionErrorPercent: '9.6',
    walletAddress: '0x91Ee0b4C7a3D58f26104Bd79Ae5C38f0172Dba64',
    verifyUrl: addressUrl('0x91Ee0b4C7a3D58f26104Bd79Ae5C38f0172Dba64'),
  },
];

const jobs: readonly AgentJobRowDto[] = [
  {
    jobId: heroDub.jobId,
    creatorHandle: 'maya_builds',
    targetLanguageName: 'Spanish',
    state: 'EARNING',
    statusLabel: 'live and earning',
    cost: money('400000', '$0.40'),
    revenue: money('1976000', '$1.98'),
    profit: money('1576000', '$1.58'),
    roiPercent: '394.0',
    unlocks: 247,
    qcPassed: true,
  },
  {
    jobId: ptDub.jobId,
    creatorHandle: 'maya_builds',
    targetLanguageName: 'Portuguese',
    state: 'SETTLED',
    statusLabel: 'paid out',
    cost: money('400000', '$0.40'),
    revenue: money('768000', '$0.77'),
    profit: money('368000', '$0.37'),
    roiPercent: '92.0',
    unlocks: 96,
    qcPassed: true,
  },
  {
    jobId: qcRejectedDub.jobId,
    creatorHandle: 'dev_tiana',
    targetLanguageName: 'Japanese',
    state: 'REJECTED_BY_QC',
    statusLabel: 'scrapped in checks',
    cost: money('600000', '$0.60'),
    revenue: money('0', '$0.00'),
    profit: money('-600000', '-$0.60'),
    roiPercent: '-100.0',
    unlocks: 0,
    qcPassed: false,
  },
  {
    jobId: dubbingDub.jobId,
    creatorHandle: 'arjun.codes',
    targetLanguageName: 'Hindi',
    state: 'DUBBING',
    statusLabel: 'being dubbed',
    cost: money('500000', '$0.50'),
    revenue: money('0', '$0.00'),
    profit: money('-500000', '-$0.50'),
    roiPercent: null,
    unlocks: 0,
    qcPassed: null,
  },
  {
    jobId: 'dub_ko_1f08',
    creatorHandle: 'nilsvlogs',
    targetLanguageName: 'Korean',
    state: 'DECLINED',
    statusLabel: 'passed on',
    cost: money('0', '$0.00'),
    revenue: money('0', '$0.00'),
    profit: money('0', '$0.00'),
    roiPercent: null,
    unlocks: 0,
    qcPassed: null,
  },
];

const decisions: readonly DecisionLogEntryDto[] = [
  {
    jobId: heroDub.jobId,
    agentName: 'Scout',
    decision: 'APPROVE',
    won: true,
    claimedByAgentName: null,
    declineReason: null,
    rationale:
      'Estimated 2,000 Spanish views at a 12.5% unlock rate, so about 250 unlocks. Parrot keeps $0.008 of each $0.02 unlock, which is $2.00, and there is a 70% chance the dub passes checks. Against a $0.40 bill that is $1.00 of expected profit. Dubbing.',
    math: {
      predictedViews: 2000,
      conversionPercent: '12.5',
      pSuccessPercent: '70',
      rPerView: money('1000', '$0.001'),
      agentTakePerUnlock: money('8000', '$0.008'),
      unlockPrice: money('20000', '$0.02'),
      agentSharePercent: '40',
      expectedRevenue: money('2000000', '$2.00'),
      dubCost: money('400000', '$0.40'),
      ev: money('1000000', '$1.00'),
      minMargin: money('100000', '$0.10'),
      confidencePercent: '62',
      basis: 'cold_start',
    },
    decidedAt: at(215),
    creatorHandle: 'maya_builds',
    targetLanguageName: 'Spanish',
  },
  {
    jobId: 'dub_ko_1f08',
    agentName: 'Scout',
    decision: 'DECLINE',
    won: false,
    claimedByAgentName: null,
    declineReason: 'LOW_EV',
    rationale:
      'Estimated only 180 Korean views, which is about 22 unlocks and $0.13 back after the quality discount. Dubbing it costs $0.55, so this one loses money. Passing for now.',
    math: {
      predictedViews: 180,
      conversionPercent: '12.5',
      pSuccessPercent: '70',
      rPerView: money('1000', '$0.001'),
      agentTakePerUnlock: money('8000', '$0.008'),
      unlockPrice: money('20000', '$0.02'),
      agentSharePercent: '40',
      expectedRevenue: money('180000', '$0.18'),
      dubCost: money('550000', '$0.55'),
      ev: money('-424000', '-$0.42'),
      minMargin: money('100000', '$0.10'),
      confidencePercent: '41',
      basis: 'cold_start',
    },
    decidedAt: at(96),
    creatorHandle: 'nilsvlogs',
    targetLanguageName: 'Korean',
  },
  {
    jobId: qcRejectedDub.jobId,
    agentName: 'Magpie',
    decision: 'APPROVE',
    won: true,
    claimedByAgentName: null,
    declineReason: null,
    rationale:
      'Estimated 1,400 Japanese views at a 12.5% unlock rate, worth $1.40 before the quality discount, against a $0.60 bill. Worth a shot at $0.38 of expected profit. Dubbing.',
    math: {
      predictedViews: 1400,
      conversionPercent: '12.5',
      pSuccessPercent: '70',
      rPerView: money('1000', '$0.001'),
      agentTakePerUnlock: money('8000', '$0.008'),
      unlockPrice: money('20000', '$0.02'),
      agentSharePercent: '40',
      expectedRevenue: money('1400000', '$1.40'),
      dubCost: money('600000', '$0.60'),
      ev: money('380000', '$0.38'),
      minMargin: money('100000', '$0.10'),
      confidencePercent: '55',
      basis: 'bucket',
    },
    decidedAt: at(640),
    creatorHandle: 'dev_tiana',
    targetLanguageName: 'Japanese',
  },
  {
    jobId: ptDub.jobId,
    agentName: 'Owl',
    decision: 'APPROVE',
    won: true,
    claimedByAgentName: null,
    declineReason: null,
    rationale:
      'Portuguese clips from this creator have converted at 13.1% across six runs, so 900 views is about 118 unlocks and $0.94. The $0.40 bill leaves $0.26 of expected profit. Dubbing.',
    math: {
      predictedViews: 900,
      conversionPercent: '13.1',
      pSuccessPercent: '70',
      rPerView: money('1000', '$0.001'),
      agentTakePerUnlock: money('8000', '$0.008'),
      unlockPrice: money('20000', '$0.02'),
      agentSharePercent: '40',
      expectedRevenue: money('943000', '$0.94'),
      dubCost: money('400000', '$0.40'),
      ev: money('260000', '$0.26'),
      minMargin: money('100000', '$0.10'),
      confidencePercent: '78',
      basis: 'bucket',
    },
    decidedAt: at(1520),
    creatorHandle: 'maya_builds',
    targetLanguageName: 'Portuguese',
  },
];

export const tickerSeed: readonly TickerEntryDto[] = [
  {
    id: 'tk_1',
    kind: 'unlock',
    text: 'Someone in Mexico City unlocked the Spanish dub',
    amount: money('20000', '$0.02'),
    at: at(1),
    verifyUrl: null,
    simulated: true,
  },
  {
    id: 'tk_2',
    kind: 'settlement',
    text: 'Scout paid out $0.19 of creator earnings',
    amount: money('190000', '$0.19'),
    at: at(3),
    verifyUrl: tx(0),
    simulated: false,
  },
  {
    id: 'tk_3',
    kind: 'unlock',
    text: 'Someone in Bogota unlocked the Spanish dub',
    amount: money('20000', '$0.02'),
    at: at(4),
    verifyUrl: null,
    simulated: true,
  },
  {
    id: 'tk_4',
    kind: 'decision',
    text: 'Scout passed on a Korean clip: too few viewers to cover the cost',
    amount: null,
    at: at(6),
    verifyUrl: null,
    simulated: true,
  },
  {
    id: 'tk_5',
    kind: 'qc',
    text: 'Magpie scrapped a Japanese dub in final checks and booked the loss',
    amount: money('-600000', '-$0.60'),
    at: at(9),
    verifyUrl: null,
    simulated: true,
  },
  {
    id: 'tk_6',
    kind: 'dub',
    text: 'Owl started dubbing a Hindi clip for @arjun.codes',
    amount: money('500000', '$0.50'),
    at: at(12),
    verifyUrl: null,
    simulated: true,
  },
  {
    id: 'tk_7',
    kind: 'settlement',
    text: 'Owl paid out $0.46 of creator earnings',
    amount: money('460000', '$0.46'),
    at: at(16),
    verifyUrl: tx(2),
    simulated: false,
  },
  {
    id: 'tk_8',
    kind: 'unlock',
    text: 'Someone in Lisbon unlocked the Portuguese dub',
    amount: money('20000', '$0.02'),
    at: at(18),
    verifyUrl: null,
    simulated: true,
  },
];

const accuracy: readonly AccuracyPointDto[] = [
  { at: at(2600), predicted: 2400, actual: 980, errorPercent: 59.2, simulated: true },
  { at: at(2300), predicted: 2100, actual: 1120, errorPercent: 46.7, simulated: true },
  { at: at(2000), predicted: 1600, actual: 1010, errorPercent: 36.9, simulated: true },
  { at: at(1700), predicted: 1400, actual: 1180, errorPercent: 15.7, simulated: true },
  { at: at(1400), predicted: 900, actual: 702, errorPercent: 22.0, simulated: true },
  { at: at(1100), predicted: 1500, actual: 1320, errorPercent: 12.0, simulated: true },
  { at: at(800), predicted: 1800, actual: 1690, errorPercent: 6.1, simulated: true },
  { at: at(500), predicted: 2000, actual: 1840, errorPercent: 8.0, simulated: true },
  { at: at(200), predicted: 1200, actual: 1140, errorPercent: 5.0, simulated: true },
];

const feed: FeedStatusDto = {
  live: true,
  source: 'simulated',
  latestBlock: '4180237',
  lastEventAt: at(1),
};

export const agentDashboard: AgentDashboardDto = {
  agents,
  jobs,
  decisions,
  ticker: tickerSeed,
  accuracy,
  totals: {
    balance: money('21159000', '$21.16'),
    spend: money('11190000', '$11.19'),
    revenue: money('15238000', '$15.24'),
    profit: money('4048000', '$4.05'),
    unlocks: 612,
    dubsPublished: 28,
    dubsRejected: 3,
  },
  feed,
};

// ---------------------------------------------------------------------------
// Bot console
// ---------------------------------------------------------------------------

export const botConsole: BotConsoleDto = {
  live: false,
  simulated: true,
  posts: [
    {
      id: 'post_1',
      authorHandle: 'maya_builds',
      authorDisplayName: 'Maya Okonjo',
      text: 'spent four months on this workshop build. 30 seconds of it, sound on.',
      createdAt: at(260),
      isBot: false,
      inReplyToId: null,
      metrics: { likes: 4120, replies: 210, reposts: 388, views: 91200 },
      hasVideo: true,
      jobId: null,
    },
    {
      id: 'post_2',
      authorHandle: 'luis.ruiz',
      authorDisplayName: 'Luis Ruiz',
      text: '@parrot dub this to Spanish',
      createdAt: at(230),
      isBot: false,
      inReplyToId: 'post_1',
      metrics: { likes: 31, replies: 2, reposts: 1, views: 1900 },
      hasVideo: false,
      jobId: null,
    },
    {
      id: 'post_3',
      authorHandle: 'parrot',
      authorDisplayName: 'Parrot',
      text: 'Squawk! On it - dubbing this into Spanish now. Your link lands here in about a minute.',
      createdAt: at(228),
      isBot: true,
      inReplyToId: 'post_2',
      metrics: { likes: 96, replies: 4, reposts: 12, views: 8800 },
      hasVideo: false,
      jobId: heroDub.jobId,
    },
    {
      id: 'post_4',
      authorHandle: 'parrot',
      authorDisplayName: 'Parrot',
      text: 'Your Spanish dub is live -> /dub/' + heroDub.jobId + ' - you earn every time someone watches it.',
      createdAt: at(212),
      isBot: true,
      inReplyToId: 'post_2',
      metrics: { likes: 530, replies: 22, reposts: 61, views: 40100 },
      hasVideo: false,
      jobId: heroDub.jobId,
    },
    {
      id: 'post_5',
      authorHandle: 'parrot',
      authorDisplayName: 'Parrot',
      text: 'Someone just watched your Spanish dub. You earned $0.012.',
      createdAt: at(200),
      isBot: true,
      inReplyToId: 'post_1',
      metrics: { likes: 44, replies: 1, reposts: 2, views: 3100 },
      hasVideo: false,
      jobId: heroDub.jobId,
    },
    {
      id: 'post_6',
      authorHandle: 'nilsvlogs',
      authorDisplayName: 'Nils',
      text: '@parrot dub this to Korean',
      createdAt: at(98),
      isBot: false,
      inReplyToId: null,
      metrics: { likes: 3, replies: 1, reposts: 0, views: 180 },
      hasVideo: true,
      jobId: null,
    },
    {
      id: 'post_7',
      authorHandle: 'parrot',
      authorDisplayName: 'Parrot',
      text: 'Passing on this one for now: not enough interest yet to cover the cost of dubbing it. Reply again once that changes and I will take another look.',
      createdAt: at(96),
      isBot: true,
      inReplyToId: 'post_6',
      metrics: { likes: 12, replies: 0, reposts: 0, views: 640 },
      hasVideo: false,
      jobId: 'dub_ko_1f08',
    },
  ],
};

export const demoState: DemoStateDto = {
  seeded: true,
  trafficRunning: false,
  ratePerMinute: 40,
  compressedLearning: true,
};
