import { describe, it, expect } from 'vitest';
import { micros, parseUsd, DEFAULT_POST_BUDGET, DEFAULT_VALUE_PER_THOUSAND_VIEWS } from '@parrot/shared';
import { Store } from '../src/store/store.js';
import { CampaignService, type CampaignDeps } from '../src/services/campaign-service.js';
import { BillingService, allocate } from '../src/services/billing-service.js';
import { DemoPayer } from '../src/services/payers.js';
import { guessLanguage } from '../src/services/reply-languages.js';
import { demoViewsFor, tasteFor } from '../src/services/demo-audience.js';

function setup(opts: { failQc?: boolean; balance?: string } = {}) {
  const store = new Store();
  const account = store.createAccount({ kind: 'creator', label: 'm', email: null, walletAddress: null });
  store.appendLedger({ accountId: account.id, amount: parseUsd(opts.balance ?? '25'), kind: 'demo_credit' });
  const creator = store.createCreator({
    xUserId: 'x1', handle: 'maria', displayName: 'Maria', accountId: account.id, followers: 1, userId: null,
    valuePerThousand: DEFAULT_VALUE_PER_THOUSAND_VIEWS, valueIsDefault: true, postBudget: DEFAULT_POST_BUDGET,
    autoDub: false, sourceLang: 'en', lowBalance: false,
  });
  const payer = new DemoPayer(store);
  const deps: CampaignDeps = {
    store,
    dubbing: {
      createDub: async () => ({ providerJobId: 'job', simulated: true }),
      pollUntilReady: async () => undefined,
      downloadDub: async () => ({ localPath: '/tmp/x.sim.wav', simulated: true }),
    },
    qc: { run: async () => ({ passed: !opts.failQc, checks: [{ name: 'language_detect', status: opts.failQc ? 'failed' : 'passed', passed: !opts.failQc, detail: 'x' }], ranAt: new Date() }) },
    publisher: { publish: async ({ dub }) => ({ postId: `p-${dub.id}`, url: `u-${dub.id}` }) },
    available: (c) => payer.available(c),
    measureWindowMs: 0,
  };
  return { store, creator, campaigns: new CampaignService(deps), billing: new BillingService({ store, payer }) };
}

const input = (creator: ReturnType<typeof setup>['creator'], id = 'src1') => ({
  creator, sourcePostId: id, sourceUrl: 'https://x/1', text: 't', durationS: 30, originalViews: 1_000_000,
});

describe('campaign', () => {
  it('orders eight dubs on a first post, makes them, and Parrot pays for each', async () => {
    const { store, creator, campaigns } = setup();
    const r = await campaigns.start(input(creator));
    if (r.kind !== 'started') throw new Error(r.kind);
    expect(r.dubs).toHaveLength(8);
    await campaigns.run(r.post.id);
    expect(store.dubsForPost(r.post.id).every((d) => d.state === 'PUBLISHED')).toBe(true);
    expect(store.ledgerTotal(store.houseAccount().id, 'dub_cost')).toBe(micros(-8n * 250_000n));
  });

  it('scraps a dub that fails QC and never posts it; creator pays nothing', async () => {
    const { store, creator, campaigns, billing } = setup({ failQc: true });
    const r = await campaigns.start(input(creator));
    if (r.kind !== 'started') throw new Error(r.kind);
    await campaigns.run(r.post.id);
    const dubs = store.dubsForPost(r.post.id);
    expect(dubs.every((d) => d.state === 'REJECTED_BY_QC' && d.replyPostId === null)).toBe(true);
    expect(billing.owed(creator)).toBe(micros(0n));
  });

  it('declines too-long clips, empty balances, and repeats', async () => {
    const a = setup();
    expect(await a.campaigns.start({ ...input(a.creator), durationS: 9999 })).toMatchObject({ kind: 'declined', reason: 'TOO_LONG' });
    const b = setup({ balance: '0' });
    expect(await b.campaigns.start(input(b.creator))).toMatchObject({ kind: 'declined', reason: 'NO_BALANCE' });
    const r = await a.campaigns.start({ ...input(a.creator), lang: 'es' });
    expect(r.kind).toBe('started');
    expect(await a.campaigns.start({ ...input(a.creator), lang: 'es' })).toMatchObject({ kind: 'duplicate' });
  });
});

describe('billing', () => {
  it('charges only for counted views, once, and never past the budget', async () => {
    const { store, creator, campaigns, billing } = setup();
    const r = await campaigns.start({ ...input(creator), lang: 'es' });
    if (r.kind !== 'started') throw new Error(r.kind);
    await campaigns.run(r.post.id);
    const dub = r.dubs[0]!;
    store.updateDub(dub.id, { xViews: 4000 });
    const c1 = await billing.chargeCreator(creator);
    expect(c1?.status).toBe('confirmed');
    expect(c1?.amount).toBe(parseUsd('4'));
    expect(await billing.chargeCreator(creator)).toBeNull();
    store.updateDub(dub.id, { xViews: 9000 });
    const c2 = await billing.chargeCreator(creator);
    expect(c2?.amount).toBe(parseUsd('1'));
    expect(store.getDub(dub.id)?.paid).toBe(parseUsd('5'));
    store.updateDub(dub.id, { xViews: 20000 });
    expect(await billing.chargeCreator(creator)).toBeNull();
    expect(store.balanceOf(creator.accountId)).toBe(parseUsd('20'));
  });

  it('allocates views across dubs without losing or inventing any', () => {
    const out = allocate(1000, [3, 3, 3]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(9 > 1000 ? 1000 : 9);
    const part = allocate(7, [10, 10, 10]);
    expect(part.reduce((a, b) => a + b, 0)).toBe(7);
  });
});

describe('reading replies and the demo audience', () => {
  it('tells languages apart from short replies', () => {
    expect(guessLanguage('¡Me encanta! Gracias, muy bueno')).toBe('es');
    expect(guessLanguage('Adorei! Muito bom, obrigado')).toBe('pt');
    expect(guessLanguage('日本語で見られて嬉しい')).toBe('ja');
    expect(guessLanguage('🔥🔥')).toBe('other');
  });

  it('is deterministic and gives Maria a real taste for Spanish over Japanese', () => {
    expect(tasteFor('maria', 'es')).toBeGreaterThan(tasteFor('maria', 'ja') * 10);
    const a = demoViewsFor({ handle: 'maria', lang: 'es', postId: 'p', originalViews: 1_200_000 });
    expect(a).toBe(demoViewsFor({ handle: 'maria', lang: 'es', postId: 'p', originalViews: 1_200_000 }));
    expect(a).toBeGreaterThan(250);
  });

  it('gives any creator three clearly strong languages and mostly weak ones, so a demo has something to find', () => {
    const langs = ['es', 'pt', 'hi', 'fr', 'de', 'ja', 'ko', 'ar', 'id'];
    for (const handle of ['eyeftruth', 'someone', 'x']) {
      const tastes = langs.map((l) => tasteFor(handle, l));
      expect(tastes.filter((t) => t >= 1.6)).toHaveLength(3);
      expect(tastes.filter((t) => t < 0.2).length).toBeGreaterThanOrEqual(4);
    }
  });
});
