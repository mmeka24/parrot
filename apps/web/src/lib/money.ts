import type { MoneyDto } from '@parrot/shared';

/**
 * Fixture helper. The UI NEVER does money arithmetic: every amount it shows is
 * a pre-formatted `display` string that arrived from the server (or, offline,
 * from these fixtures). `micros` is carried along verbatim and never parsed.
 */
export function money(microsValue: string, display: string): MoneyDto {
  return { micros: microsValue, display };
}

export const ZERO = money('0', '$0.00');
