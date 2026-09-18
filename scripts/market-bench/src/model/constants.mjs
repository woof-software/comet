// Scales and type ceilings, as declared in CometCore.

export const IDX_SCALE   = 10n ** 15n;   // BASE_INDEX_SCALE
export const FACTOR      = 10n ** 18n;   // FACTOR_SCALE
export const SPY         = 31_536_000n;  // SECONDS_PER_YEAR
export const MAXES = { 64: 2n ** 64n - 1n, 128: 2n ** 128n - 1n, 256: 2n ** 256n - 1n };
