import { describe, expect, it } from 'vitest'
import { buildDdzModel, buildDdzXml, buildEmployerReport, ddzFileName, easterSunday, holidays, missingSettings, normHours, payroll, reportedHours, type EmployerSettings } from '../../src/lib/employerReport'
import { canSubmit, isChecked, isSubmitted, messagesOf, shapeOf, tokenMessage, validateEdsRequest } from '../../supabase/functions/eds/validate'

const settings: EmployerSettings = {
  taxpayerNo: '40000000001', email: 'owner@example.com', phone: '20000000', preparedBy: 'ANNA PARAUGA',
  personalCode: '01010112345', employeeName: 'ANNA   PARAUGA', gross: 1600, dependants: 1, adminHours: 5,
}
const months = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)

describe('working-time norm', () => {
  it('matches the published 2026 calendar (250 days, 1994 hours)', () => {
    expect(months(2026).map((m) => normHours(m))).toEqual([168, 160, 176, 158, 152, 159, 184, 168, 176, 176, 159, 158])
  })

  it('follows the holiday rules', () => {
    expect(easterSunday(2026)).toBe('2026-04-05')
    const y = holidays(2026)
    expect(y.holidays.has('2026-04-03')).toBe(true) // Good Friday
    expect(y.holidays.has('2026-04-06')).toBe(true) // Easter Monday
    expect([...y.daysOff]).toEqual([]) // 4 May and 18 November are weekdays in 2026
    // 2024: 4 May is a Saturday, so Monday 6 May is off and Friday 3 May is a shortened eve.
    expect([...holidays(2024).daysOff]).toEqual(['2024-05-06'])
    expect(normHours('2024-05')).toBe(167)
    // A one-off holiday from the settings takes a day and shortens its eve.
    expect(normHours('2026-07', ['2026-07-15'])).toBe(184 - 8 - 1)
  })

  it('reports whole tracked hours plus the administrative hours, capped at the norm', () => {
    expect(reportedHours(178.83 * 60, 5, 176)).toBe(176)
    expect(reportedHours(110.5 * 60, 5, 168)).toBe(116) // half an hour rounds up
    expect(reportedHours(0, 5, 160)).toBe(5)
  })
})

describe('payroll', () => {
  it('derives contributions and tax from the gross salary', () => {
    expect(payroll(1600, 2026, { dependants: 1 })).toEqual({ gross: 1600, socialTotal: 545.44, socialEmployee: 168, incomeTax: 161.16, riskDuty: 0.36, net: 1270.84 })
    expect(payroll(1600, 2026).incomeTax).toBe(224.91) // no dependants
    expect(payroll(1600, 2025).incomeTax).toBe(235.11) // 510 minimum in 2025
    expect(payroll(1600, 2026, { taxBook: false }).incomeTax).toBe(365.16) // no reliefs
    expect(payroll(700, 2026, { dependants: 3 }).incomeTax).toBe(0) // reliefs above the income
    expect(payroll(1600, 2026, { riskDuty: false }).riskDuty).toBe(0)
    expect(() => payroll(1600, 2040)).toThrow(/2040/) // unknown year: do not guess the minimum
    expect(() => payroll(20000, 2026)).toThrow(/25\.5/)
  })
})

describe('employer report', () => {
  it('builds the month from tracked minutes and settings', () => {
    const r = buildEmployerReport({ month: '2026-10', trackedMinutes: 177.67 * 60, settings })
    expect(r).toMatchObject({ norm: 176, suggestedHours: 176, hours: 176, capped: true, adminHours: 5 })
    const august = buildEmployerReport({ month: '2026-08', trackedMinutes: 110.5 * 60, settings })
    expect(august).toMatchObject({ norm: 168, hours: 116, capped: false })
    // The owner's own figure wins; a pinned norm replaces the computed one.
    expect(buildEmployerReport({ month: '2026-08', trackedMinutes: 0, settings, hours: 150 }).hours).toBe(150)
    expect(buildEmployerReport({ month: '2026-08', trackedMinutes: 9999 * 60, settings: { ...settings, normHours: { '2026-08': 160 } } }).hours).toBe(160)
    expect(missingSettings(undefined)).toEqual(['company registration number', 'personal code', 'employee name', 'gross salary'])
    expect(missingSettings(settings)).toEqual([])
    expect(ddzFileName('2026-10')).toBe('DDZ_2026-10.xml')
  })

  it('writes the DokDDZv5 XML as EDS exports it, without Id and UID', () => {
    const xml = buildDdzXml(settings, buildEmployerReport({ month: '2026-09', trackedMinutes: 0, settings, hours: 173 }))
    const lines = xml.split('\n').map((l) => l.trim())
    expect(lines[0]).toBe('<?xml version="1.0" encoding="utf-8"?>')
    expect(lines[1]).toBe('<DokDDZv5 xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
    expect(lines).toEqual(expect.arrayContaining([
      '<NmrKods>40000000001</NmrKods>', '<ParskGads>2026</ParskGads>', '<ParskMen>09</ParskMen>',
      '<PersonasKods>01010112345</PersonasKods>', '<VardsUzvards>ANNA   PARAUGA</VardsUzvards>', '<Statuss>DN</Statuss>',
      '<Ienakumi>1600.00</Ienakumi>', '<Iemaksas>545.44</Iemaksas>', '<IeturetaisNodoklis>161.16</IeturetaisNodoklis>',
      '<RiskaNodevasPazime>true</RiskaNodevasPazime>', '<RiskaNodeva>0.36</RiskaNodeva>', '<Stundas>173</Stundas>',
      '<IemaksuDatums xsi:nil="true" />', '<Tab2 />', '<Tab16 />', '<Pielikumi />', '<PrecizetieIenakumi>0</PrecizetieIenakumi>',
    ]))
    expect(xml).not.toMatch(/<Id>|<UID>|<Tab15/)
    expect(lines.filter((l) => /^<Tab\d+ \/>$/.test(l))).toHaveLength(14)
    // Text is escaped.
    expect(buildDdzXml({ ...settings, preparedBy: 'A & B <C>' }, buildEmployerReport({ month: '2026-01', trackedMinutes: 0, settings }))).toContain('<Sagatavotajs>A &amp; B &lt;C&gt;</Sagatavotajs>')
  })

  it('builds the EDS API model with its field names', () => {
    const model = buildDdzModel(settings, buildEmployerReport({ month: '2026-10', trackedMinutes: 9999 * 60, settings }))
    expect(model).toMatchObject({ ParskGads: 2026, ParskMen: '10', NmrKods: '40000000001', Precizejums: false, Ienakumi: 1600, Iemaksas: 545.44, IeturetaisNodoklis: 161.16, RiskaNodeva: 0.36 })
    expect(model.Tabula1).toEqual([{
      PersonasKods: '01010112345', VardsUzvards: 'ANNA   PARAUGA', Statuss: 'DN', Ienakumi: 1600, Iemaksas: 545.44, PrecizetasIemaksas: 0,
      IeturetaisNodoklis: 161.16, DarbaVeids: '1', RiskaNodevasPazime: true, RiskaNodeva: 0.36, Stundas: 176, IenakumiIzmaksatiSkaidraNauda: false,
    }])
    expect(validateEdsRequest({ action: 'send', model })).toMatchObject({ ok: true })
  })
})

describe('eds function requests', () => {
  const model = buildDdzModel(settings, buildEmployerReport({ month: '2026-10', trackedMinutes: 0, settings }))

  it('accepts the four actions and rejects the rest', () => {
    expect(validateEdsRequest({ action: 'status', documentId: 5 })).toEqual({ ok: true, value: { action: 'status', documentId: 5 } })
    expect(validateEdsRequest({ action: 'send', model, documentId: 7 })).toMatchObject({ ok: true, value: { action: 'send', documentId: 7 } })
    expect(validateEdsRequest({ action: 'diagnose' })).toEqual({ ok: true, value: { action: 'diagnose' } })
    expect(validateEdsRequest(null)).toMatchObject({ ok: false })
    expect(validateEdsRequest({ action: 'submit' })).toMatchObject({ ok: false, error: expect.stringContaining('documentId') })
    expect(validateEdsRequest({ action: 'delete', documentId: '5' })).toMatchObject({ ok: false })
    expect(validateEdsRequest({ action: 'approve', documentId: 5 })).toMatchObject({ ok: false, error: expect.stringContaining('action') })
    expect(validateEdsRequest({ action: 'send' })).toMatchObject({ ok: false, error: expect.stringContaining('model') })
    expect(validateEdsRequest({ action: 'send', model: { ...model, ParskMen: '13' } })).toMatchObject({ ok: false, error: expect.stringContaining('ParskMen') })
    expect(validateEdsRequest({ action: 'send', model: { ...model, Tabula1: [] } })).toMatchObject({ ok: false, error: expect.stringContaining('Tabula1') })
    expect(validateEdsRequest({ action: 'send', model: { ...model, Tabula1: [{ PersonasKods: '1', Stundas: 1000 }] } })).toMatchObject({ ok: false, error: expect.stringContaining('Stundas') })
  })

  it('describes a credential without giving it away', () => {
    expect(shapeOf('40000000001')).toBe('40…01 (11 digits)')
    expect(shapeOf('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('0f…0e (36 characters, a GUID)')
    expect(shapeOf('my key')).toBe('… (6 characters)')
    expect(shapeOf('12345')).toBe('… (5 digits)')
  })

  it('reads the state of a document', () => {
    const fresh = { Id: 5, Statuss: 'Sagatavots', VarIesniegt: false }
    const ready = { Id: 5, Statuss: 'Gatavs iesniegšanai', VarIesniegt: true, ParbaudesRezultats: { Bridinajums: ['Pārbaudiet stundas'] } }
    const broken = { Id: 5, VarIesniegt: true, ParbaudesRezultats: { Kluda: ['Nepareizs personas kods'] } }
    const sent = { Id: 5, Statuss: 'Iesniegts', Iesniegts: '2026-11-17T10:00:00', VarIesniegt: false }
    expect([isChecked(fresh), isChecked(ready), isChecked(broken)]).toEqual([false, true, true])
    expect(messagesOf(ready)).toEqual({ errors: [], warnings: ['Pārbaudiet stundas'], info: [] })
    expect([canSubmit(fresh), canSubmit(ready), canSubmit(broken), canSubmit(sent), canSubmit(null)]).toEqual([false, true, false, false, false])
    expect([isSubmitted(ready), isSubmitted(sent)]).toEqual([false, true])
  })

  it('signs the certificate token for the day in Latvia', () => {
    expect(tokenMessage('40000000001', new Date('2026-11-07T12:00:00Z'))).toBe('40000000001:2026.11.07')
    expect(tokenMessage('40000000001', new Date('2026-11-07T22:30:00Z'))).toBe('40000000001:2026.11.08') // already the 8th in Riga
  })
})
