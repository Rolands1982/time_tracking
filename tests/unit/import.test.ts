import { beforeAll, describe, expect, it } from 'vitest'
import { guessClientName, parseBilled, parseWorkbook, type ParseResult } from '../../src/lib/excel/importWorkbook'
import { parseDateString, rateFromFormula } from '../../src/lib/excel/cells'
import { buildFixtureWorkbook } from './fixtures'

describe('Excel import', () => {
  let result: ParseResult
  beforeAll(async () => {
    result = await parseWorkbook(await buildFixtureWorkbook(), { clientName: 'Polystylex', defaultRate: 0 })
  })

  it('finds the time sheets and ignores other sheets', () => {
    const names = result.sheets.map((s) => `${s.name}:${s.imported}`)
    expect(names).toEqual(['October:4', 'Jan 2019:4', 'Support:3', 'Notes:0', 'Uzskaite:3', 'ViVi:1'])
    expect(result.sheets.find((s) => s.name === 'Notes')?.reason).toMatch(/no Date/)
  })

  it('carries blank dates down and handles Excel midnight (24:00)', () => {
    const oct = result.entries.filter((e) => e.sheet === 'October')
    expect(oct.map((e) => e.date)).toEqual(['2018-10-01', '2018-10-01', '2018-10-01', '2018-10-02'])
    expect(oct[2]).toMatchObject({ startTime: '21:30', endTime: '00:00', durationMin: 150, hourlyRate: 60, amount: 150 })
  })

  it('derives the hourly rate from the Earned formula, falling back to earned/hours', () => {
    expect(result.entries.find((e) => e.sheet === 'October')?.hourlyRate).toBe(60)
    expect(result.entries.find((e) => e.sheet === 'Support')?.hourlyRate).toBe(50)
    const typed = result.entries.find((e) => e.comments.startsWith('String times'))
    expect(typed).toMatchObject({ startTime: '13:00', endTime: '13:15', durationMin: 15, hourlyRate: 50, amount: 12.5 })
  })

  it('uses hours typed directly into the sheet instead of the times', () => {
    const typed = result.entries.find((e) => e.comments.startsWith('Typed hours'))
    expect(typed).toMatchObject({ startTime: '12:00', endTime: '13:00', durationMin: 60, amount: 60 })
    expect(result.warnings.some((w) => w.includes('October!5'))).toBe(true)
  })

  it('reads project, category and billing status', () => {
    const vps = result.entries.filter((e) => e.project === 'VPS')
    expect(vps).toHaveLength(2)
    const support = result.entries.filter((e) => e.sheet === 'Support')
    expect(support[0]).toMatchObject({ category: 'Support', isBilled: true, invoiceDate: '2023-10-01' })
    expect(support[1]).toMatchObject({ category: 'Izstrāde', isBilled: false })
    expect(support[2]).toMatchObject({ isBilled: true, invoiceDate: undefined })
  })

  it('assigns the client name and a content-based import key', () => {
    expect(new Set(result.entries.map((e) => e.client))).toEqual(new Set(['Polystylex']))
    const dupes = result.entries.filter((e) => e.comments === 'Initial analysis')
    expect(dupes).toHaveLength(2)
    expect(dupes[0].importKey).toBe(dupes[1].importKey)
  })

  it('totals match what the sheets say', () => {
    const hours = result.entries.reduce((s, e) => s + e.durationMin, 0) / 60
    expect(hours).toBeCloseTo(1 + 2 + 2.5 + 1 + 2 + 1 + 3 + 3 + 1 + 0.5 + 0.25 + 0.5 + 1 + 0.5 + 1, 5)
  })

  it('understands Latvian headers, month-label invoices and non-billable rows', () => {
    const lv = result.entries.filter((e) => e.sheet === 'Uzskaite')
    expect(lv[0]).toMatchObject({ project: 'Locitech', category: 'Izpēte', hourlyRate: 50, isBilled: true, invoiceDate: '2023-06-30', invoiceRef: 'Jūnijs 2023', comments: 'Sapulce' })
    expect(lv[1]).toMatchObject({ project: 'Fazer', isBilled: false, billable: false })
    expect(lv[2]).toMatchObject({ isBilled: false, billable: undefined })
  })

  it('takes the rate from a money formula placed under the hours header', () => {
    expect(result.entries.find((e) => e.sheet === 'ViVi')).toMatchObject({ durationMin: 60, hourlyRate: 80, amount: 80 })
  })
})

describe('cell helpers', () => {
  it('extracts rate constants from formulas', () => {
    expect(rateFromFormula('D2*60')).toBe(60)
    expect(rateFromFormula('IF(ISBLANK(B3),"",D3*50)')).toBe(50)
    expect(rateFromFormula('IF(ISBLANK(B3),"",D3*47.5)')).toBe(47.5)
    expect(rateFromFormula('SUM(E:E)')).toBeNull()
    expect(rateFromFormula(undefined)).toBeNull()
  })

  it('parses several date formats', () => {
    expect(parseDateString('01/10/2023')).toBe('2023-10-01')
    expect(parseDateString('1.7.2024')).toBe('2024-07-01')
    expect(parseDateString('2024-07-01')).toBe('2024-07-01')
    expect(parseDateString('nope')).toBeNull()
  })

  it('interprets billing cells', () => {
    expect(parseBilled('Billed 01/10/2023')).toEqual({ isBilled: true, invoiceDate: '2023-10-01', invoiceRef: undefined })
    expect(parseBilled('Aprīlis 2024')).toEqual({ isBilled: true, invoiceDate: '2024-04-30', invoiceRef: 'Aprīlis 2024' })
    expect(parseBilled('INV-2024-017')).toEqual({ isBilled: true, invoiceDate: undefined, invoiceRef: 'INV-2024-017' })
    expect(parseBilled('Nepiestādāmas')).toEqual({ isBilled: false, billable: false })
    expect(parseBilled('yes')).toEqual({ isBilled: true, invoiceDate: undefined, invoiceRef: undefined })
    expect(parseBilled('')).toEqual({ isBilled: false })
    expect(parseBilled('no')).toEqual({ isBilled: false })
    expect(parseBilled('x', '2024-01-05')).toEqual({ isBilled: true, invoiceDate: '2024-01-05', invoiceRef: undefined })
    expect(parseBilled('', '2024-01-05')).toEqual({ isBilled: true, invoiceDate: '2024-01-05', invoiceRef: undefined })
  })

  it('guesses client names from file names', () => {
    expect(guessClientName('Working_schedule_Polystylex.xlsx')).toBe('Polystylex')
    expect(guessClientName('0c6c65ac-Working_schedule_Polystylex.xlsx')).toBe('Polystylex')
    expect(guessClientName('Time tracking - Acme Corp 2024.xlsx')).toBe('Acme Corp')
    expect(guessClientName('Stundu_uzskaite_-_ELVA.xlsx')).toBe('ELVA')
    expect(guessClientName('Stundu_uzskaite.xlsx')).toBe('Stundu uzskaite')
  })
})
