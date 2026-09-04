// src/lib/strategy.ts
export const STRATEGY = {
    MANUAL: 'Manual / Direct',
    SNIPER: 'Sniper Engine',
    COPY:   'Copy Trade',
    DCA:    'DCA Engine',
    LIMIT:  'Limit Order',
    CALLER: 'AI Caller',
    LAUNCH: 'Token Launchpad',
  } as const;
  
  export type StrategyLabel = typeof STRATEGY[keyof typeof STRATEGY];
  
  const ALIASES: Record<string, StrategyLabel> = {
    'MANUAL': STRATEGY.MANUAL,
    'MANUAL / DIRECT': STRATEGY.MANUAL,
    'DIRECT': STRATEGY.MANUAL,
    'SNIPER': STRATEGY.SNIPER,
    'SNIPER ENGINE': STRATEGY.SNIPER,
    'AUTO': STRATEGY.SNIPER,
    'COPY_TRADE': STRATEGY.COPY,
    'COPY TRADE': STRATEGY.COPY,
    'COPY': STRATEGY.COPY,
    'DCA': STRATEGY.DCA,
    'DCA ENGINE': STRATEGY.DCA,
    'LIMIT': STRATEGY.LIMIT,
    'LIMIT ORDER': STRATEGY.LIMIT,
    'AI CALLER': STRATEGY.CALLER,
    'CALLER': STRATEGY.CALLER,
    'AI COIN CALLER': STRATEGY.CALLER,
    'TOKEN LAUNCHPAD': STRATEGY.LAUNCH,
    'LAUNCH': STRATEGY.LAUNCH,
    'LAUNCHPAD': STRATEGY.LAUNCH,
  };
  
  export function normalizeStrategy(raw?: string | null): StrategyLabel {
    const key = (raw ?? '').trim().toUpperCase();
    return ALIASES[key] ?? STRATEGY.MANUAL;
  }
  
  export const STRATEGY_ORDER: StrategyLabel[] = [
    STRATEGY.SNIPER,
    STRATEGY.MANUAL,
    STRATEGY.COPY,
    STRATEGY.DCA,
    STRATEGY.LIMIT,
    STRATEGY.CALLER,
    STRATEGY.LAUNCH,
  ];