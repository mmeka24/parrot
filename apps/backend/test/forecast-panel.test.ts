import { describe, it, expect } from 'vitest';
import { DEFAULT_POST_BUDGET, DEFAULT_VALUE_PER_THOUSAND_VIEWS, planLanguages } from '@parrot/shared';
import { extensionForecast, sharePercentOf } from '../src/api/mappers.js';
import type { Creator } from '../src/store/types.js';

const creator = {
  id: 'c', handle: 'eyeftruth', valuePerThousand: DEFAULT_VALUE_PER_THOUSAND_VIEWS, valueIsDefault: true,
  postBudget: DEFAULT_POST_BUDGET, sourceLang: 'en',
} as unknown as Creator;

describe('the forecast the strip shows', () => {
  const f = extensionForecast({ creator, plan: planLanguages([]), postId: '1', originalViews: 8, durationS: 117 });

  it('spells out the three percentages and the Spanish worked example', () => {
    expect(f.funnel.reachPercent).toBe(35);
    expect(f.funnel.uptakePercent).toBe(2);
    expect(f.funnel.example.sharePercent).toBe('8.1');
    expect(f.funnel.example.dubViews).toBe(680);
    expect(f.funnel.example.youPay.display).toBe('$0.68');
  });

  it('gives the cost of one 1:57 dub and its break-even', () => {
    expect(f.funnel.dubCostEach.display).toBe('$0.975');
    expect(f.funnel.breakEvenViews).toBe(975);
    expect(f.totals.dubCost.display).toBe('$7.80');
  });

  it('shows each language its share of X', () => {
    expect(sharePercentOf('es')).toBe('8.1');
    expect(f.languages.find((l) => l.code === 'es')?.sharePercent).toBe('8.1');
  });

  it('expects about nothing from an 8-view video but not from a 1.2M-view one', () => {
    expect(f.totals.views.likely).toBe(0);
    const big = extensionForecast({ creator, plan: planLanguages([]), postId: '2', originalViews: 1_200_000, durationS: 30 });
    expect(big.totals.views.likely).toBeGreaterThan(3000);
    expect(big.totals.youPayLikely.micros).not.toBe('0');
  });
});
