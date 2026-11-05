import type { Totals } from '../db/repo'

/** Which money column a report sums: net after platform fees (the default), net in EUR, or gross as invoiced. */
export type MoneyMode = 'gross' | 'net' | 'eur'

export const DEFAULT_MONEY_MODE: MoneyMode = 'net'

export const MONEY_MODES: { key: MoneyMode; label: string }[] = [
  { key: 'net', label: 'Net' },
  { key: 'eur', label: 'Net EUR' },
  { key: 'gross', label: 'Gross' },
]

/** How many of the totals' entries are still estimates in this mode. */
export function estimatedIn(t: Totals, mode: MoneyMode): number {
  return mode === 'gross' ? 0 : mode === 'net' ? t.feeEstimated : t.estimated
}

export function amountOf(t: Totals, mode: MoneyMode): number {
  return mode === 'gross' ? t.amount : mode === 'net' ? t.netAmount : t.netAmountEur
}
