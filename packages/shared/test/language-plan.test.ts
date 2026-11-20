import { describe, it, expect } from 'vitest';
import { planLanguages, standingFor, type PostHistory } from '../src/language-plan.js';
import { addPnl, billableViews, breakEvenViews, estimateDubCost, parseUsd, pnlLine, viewCharge, viewValue } from '../src/index.js';

const post = (views: Record<string, number>, need = 250): PostHistory => ({
  results: Object.entries(views).map(([lang, v]) => ({ lang, views: v, breakEvenViews: need })),
});

describe('planLanguages', () => {
  it('explores eight languages on the first post, biggest audience first', () => {
    const plan = planLanguages([]);
    expect(plan.mode).toBe('explore');
    expect(plan.entries).toHaveLength(8);
    expect(plan.entries.every((e) => e.lang !== 'en')).toBe(true);
  });

  it('keeps the best half on the second post and tries something new', () => {
    const first = planLanguages([]);
    const views = Object.fromEntries(first.entries.map((e, i) => [e.lang, 1000 - i * 100]));
    const plan = planLanguages([post(views)]);
    expect(plan.mode).toBe('explore');
    expect(plan.entries.filter((e) => e.reason.includes('last post')).length).toBeGreaterThanOrEqual(4);
  });

  it('focuses on proven languages plus one test after the explore posts', () => {
    const history = [post({ es: 3000, pt: 1200, hi: 400, ja: 10, de: 5, fr: 100 }), post({ es: 2500, pt: 900, hi: 300, id: 150 })];
    const plan = planLanguages(history);
    expect(plan.mode).toBe('focus');
    expect(plan.entries.filter((e) => e.role === 'winner').map((e) => e.lang)).toEqual(['es', 'pt', 'hi']);
    expect(plan.entries.filter((e) => e.role === 'test')).toHaveLength(1);
  });

  it('drops a clear miss at once and a near miss after two', () => {
    expect(standingFor('ja', [post({ ja: 10 })]).status).toBe('dropped');
    expect(standingFor('fr', [post({ fr: 150 })]).status).toBe('testing');
    expect(standingFor('fr', [post({ fr: 150 }), post({ fr: 120 })]).status).toBe('dropped');
  });

  it('is deterministic', () => {
    const h = [post({ es: 3000 }), post({ es: 2000 })];
    expect(planLanguages(h)).toEqual(planLanguages(h));
  });
});

describe('money maths', () => {
  it('a 30s dub costs $0.25 and breaks even at 250 views', () => {
    expect(estimateDubCost(30)).toBe(parseUsd('0.25'));
    expect(breakEvenViews(estimateDubCost(30))).toBe(250);
  });

  it('prices a 1:57 video at about a dollar a language', () => {
    expect(estimateDubCost(117)).toBe(parseUsd('0.975'));
  });

  it('charges whole views and values them at the creator rate', () => {
    expect(viewCharge(4000)).toBe(parseUsd('4'));
    expect(viewValue(4000, parseUsd('8'))).toBe(parseUsd('32'));
  });

  it('never bills past the budget or the balance', () => {
    expect(billableViews({ totalViews: 1000, billedViews: 0, budgetLeft: parseUsd('0.5'), available: parseUsd('9') })).toBe(500);
    expect(billableViews({ totalViews: 1000, billedViews: 0, budgetLeft: parseUsd('9'), available: parseUsd('0.2') })).toBe(200);
    expect(billableViews({ totalViews: 1000, billedViews: 900, budgetLeft: parseUsd('9'), available: parseUsd('9') })).toBe(100);
  });

  it('splits the creator side and Parrot side of a language', () => {
    const win = pnlLine({ views: 4000, paid: parseUsd('4'), valuePerThousand: parseUsd('8'), dubCost: parseUsd('0.25') });
    expect(win.net).toBe(parseUsd('28'));
    expect(win.parrotNet).toBe(parseUsd('3.75'));
    const flop = pnlLine({ views: 20, paid: parseUsd('0.02'), valuePerThousand: parseUsd('8'), dubCost: parseUsd('0.25') });
    expect(flop.parrotNet).toBe(parseUsd('-0.23'));
    expect(addPnl([win, flop]).paid).toBe(parseUsd('4.02'));
  });
});

import { expectedCharge, forecastViews, languageEconomics, learnedForecast } from '../src/index.js';

describe('forecast', () => {
  it('reproduces the worked example: 1.2M views, Spanish, about 680', () => {
    const f = forecastViews(1_200_000, 'es');
    expect(f.likely).toBeGreaterThan(600);
    expect(f.likely).toBeLessThan(760);
    expect(f.low).toBeLessThan(f.likely);
    expect(f.high).toBeGreaterThan(f.likely);
  });

  it('expects almost nothing from a video nobody has seen, and never negative', () => {
    expect(forecastViews(8, 'es').likely).toBe(0);
    expect(forecastViews(-5, 'es').likely).toBe(0);
    expect(forecastViews(1_000_000, 'zz').likely).toBe(0);
  });

  it('gives bigger markets bigger forecasts', () => {
    expect(forecastViews(1_000_000, 'ja').likely).toBeGreaterThan(forecastViews(1_000_000, 'hi').likely);
  });

  it('never charges past the budget, and values views at the creator rate', () => {
    expect(expectedCharge(10_000_000, parseUsd('5'))).toBe(parseUsd('5'));
    const eco = languageEconomics({ forecast: learnedForecast(2000), dubCost: parseUsd('0.975'), valuePerThousand: parseUsd('8'), budget: parseUsd('5') });
    expect(eco.youPay.likely).toBe(parseUsd('2'));
    expect(eco.worthLikely).toBe(parseUsd('16'));
    expect(eco.breakEven).toBe(975);
  });
});
