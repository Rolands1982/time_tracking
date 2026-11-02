import type { Totals } from '../db/repo'

/** Which money column a report sums: gross as invoiced, net after platform fees, or net in EUR. */
export type MoneyMode = 'gross' | 'net' | 'eur'

export const MONEY_MODES: { key: MoneyMode; label: string }[] = [
  { key: 'gross', label: 'Gross' },
  { key: 'net', label: 'Net' },
  { key: 'eur', label: 'Net EUR' },
]

export function amountOf(t: Totals, mode: MoneyMode): number {
  return mode === 'gross' ? t.amount : mode === 'net' ? t.netAmount : t.netAmountEur
}
