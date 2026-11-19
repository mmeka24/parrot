import { describe, it, expect } from 'vitest';
import {
  parseUsd,
  formatUsd,
  centsToMicros,
  microsToNativeWei,
  nativeWeiToMicros,
  microsToErc20Units,
  erc20UnitsToMicros,
  sumMicros,
  micros,
  nativeWei,
  MICROS_PER_USD,
  NATIVE_PER_MICRO,
} from '../src/units.js';

describe('parseUsd', () => {
  it('parses whole dollars and cents', () => {
    expect(parseUsd('1')).toBe(1_000_000n);
    expect(parseUsd('0.02')).toBe(20_000n);
    expect(parseUsd('12.00')).toBe(12_000_000n);
    expect(parseUsd('0.008')).toBe(8_000n);
    expect(parseUsd('0.000001')).toBe(1n);
  });

  it('accepts a leading dollar sign and surrounding space', () => {
    expect(parseUsd(' $0.40 ')).toBe(400_000n);
  });

  it('handles negatives', () => {
    expect(parseUsd('-0.40')).toBe(-400_000n);
  });

  it('refuses sub-micro precision rather than silently rounding money away', () => {
    expect(() => parseUsd('0.0000001')).toThrow(/decimal places/);
  });

  it('refuses things that are not amounts', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e6', '$', '0x10']) {
      expect(() => parseUsd(bad), bad).toThrow();
    }
  });
});

describe('the 6-vs-18 decimal trap', () => {
  it('converts micros to native gas units and back', () => {
    const oneDollar = parseUsd('1.00');
    expect(microsToNativeWei(oneDollar)).toBe(10n ** 18n);
    expect(nativeWeiToMicros(microsToNativeWei(oneDollar))).toBe(oneDollar);
  });

  it('keeps ERC-20 units identical to micros, by construction', () => {
    const twoCents = parseUsd('0.02');
    expect(microsToErc20Units(twoCents)).toBe(20_000n);
    expect(erc20UnitsToMicros(20_000n)).toBe(twoCents);
  });

  it('the native/ERC-20 factor is exactly 10^12', () => {
    expect(NATIVE_PER_MICRO).toBe(10n ** 12n);
    expect(MICROS_PER_USD).toBe(10n ** 6n);
  });

  it('truncates sub-micro gas dust instead of rounding up', () => {
    // 1 micro + 1 wei of dust stays 1 micro
    expect(nativeWeiToMicros(nativeWei(NATIVE_PER_MICRO + 1n))).toBe(1n);
    // dust alone is worth nothing in ledger terms
    expect(nativeWeiToMicros(nativeWei(999_999_999_999n))).toBe(0n);
  });

  it('a 10^12 mix-up would be caught: native units are not micros', () => {
    const amount = parseUsd('0.02');
    expect(microsToNativeWei(amount)).not.toBe(amount as bigint);
    expect(microsToNativeWei(amount)).toBe(20_000_000_000_000_000n);
  });
});

describe('formatUsd', () => {
  it('formats to two decimals by default', () => {
    expect(formatUsd(parseUsd('1'))).toBe('$1.00');
    expect(formatUsd(parseUsd('0.02'))).toBe('$0.02');
    expect(formatUsd(parseUsd('1234.5'))).toBe('$1,234.50');
  });

  it('shows sub-cent agent economics when asked', () => {
    expect(formatUsd(parseUsd('0.008'), { maxDecimals: 3 })).toBe('$0.008');
    expect(formatUsd(parseUsd('0.001'), { maxDecimals: 3 })).toBe('$0.001');
  });

  it('formats negatives and optional plus signs', () => {
    expect(formatUsd(parseUsd('-0.40'))).toBe('-$0.40');
    expect(formatUsd(parseUsd('1.00'), { sign: true })).toBe('+$1.00');
  });

  it('round-trips through parseUsd', () => {
    for (const v of ['0.00', '0.02', '1.00', '12.34', '999.99']) {
      expect(formatUsd(parseUsd(v))).toBe(`$${Number(v).toFixed(2)}`);
    }
  });
});

describe('centsToMicros', () => {
  it('converts whole cents', () => {
    expect(centsToMicros(2)).toBe(20_000n);
    expect(centsToMicros(100)).toBe(1_000_000n);
  });

  it('rejects fractional cents', () => {
    expect(() => centsToMicros(1.5)).toThrow();
  });
});

describe('sumMicros', () => {
  it('sums exactly with no floating point drift', () => {
    const pennies = Array.from({ length: 1000 }, () => parseUsd('0.01'));
    expect(sumMicros(pennies)).toBe(parseUsd('10.00'));
  });

  it('sums an empty list to zero', () => {
    expect(sumMicros([])).toBe(0n);
  });

  it('handles mixed signs', () => {
    expect(sumMicros([micros(500n), micros(-200n)])).toBe(300n);
  });
});

describe('normalizeLanguageCode', () => {
  it('maps the three-letter codes speech-to-text reports onto the two-letter codes jobs use', async () => {
    const { normalizeLanguageCode } = await import('../src/constants.js');
    expect(normalizeLanguageCode('spa')).toBe('es');
    expect(normalizeLanguageCode('fre')).toBe('fr');
    expect(normalizeLanguageCode('fra')).toBe('fr');
    expect(normalizeLanguageCode('ger')).toBe('de');
    expect(normalizeLanguageCode('es-MX')).toBe('es');
    expect(normalizeLanguageCode('pt_BR')).toBe('pt');
    expect(normalizeLanguageCode(' ES ')).toBe('es');
    // Unknown stays unknown, so it can never match a supported language.
    expect(normalizeLanguageCode('xyz')).toBe('xyz');
  });
});
