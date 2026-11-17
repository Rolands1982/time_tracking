/**
 * Monthly employer's report (Darba devēja ziņojums, EDS document DokDDZv5) for the owner's company: one
 * employee on a fixed gross salary. Pure data: the month's working-time norm, the hours to report, the payroll
 * figures, and the document as an XML file (EDS "load from file") and as the EDS API's JSON model.
 *
 *   hours = min(round(tracked hours of the month) + administrative hours, the month's norm)
 *
 * The norm is the normal working time of a five-day, 40-hour week in Latvia: weekdays minus public holidays,
 * the working day before a holiday one hour shorter (what darbadienas.lv publishes). Company and employee
 * data come from the settings (`settings.employerReport`), never from the code.
 */
import { addDays } from './period'

export interface EmployerSettings {
  /** Company registration number (NmrKods). */
  taxpayerNo: string
  email: string
  phone: string
  /** Name of the person preparing the report. */
  preparedBy: string
  personalCode: string
  /** As EDS shows it, e.g. "NAME   SURNAME". */
  employeeName: string
  /** Monthly gross salary in EUR. */
  gross: number
  /** Dependants on the tax book (250 EUR relief each). */
  dependants: number
  /** Tax book handed to this employer: the non-taxable minimum and the dependant relief apply. Default true. */
  taxBook?: boolean
  /** Business risk duty is paid for the employee. Default true. */
  riskDuty?: boolean
  /** Social insurance status code. Default "DN". */
  status?: string
  /** Kind of employment. Default "1". */
  workType?: string
  /** Hours added to the tracked hours for administrative work. Default 5. */
  adminHours?: number
  /** One-off holidays, YYYY-MM-DD. */
  extraHolidays?: string[]
  /** Pinned norms, e.g. a year with moved working days: { "2027-01": 160 }. */
  normHours?: Record<string, number>
  /** The EDS document created for a month ("YYYY-MM"), so it is not created twice. */
  documents?: Record<string, { id: number; hours: number; submitted?: boolean }>
}

export const DEFAULT_ADMIN_HOURS = 5

// ---------------------------------------------------------------- payroll rules (amounts in cents)

const NON_TAXABLE_MINIMUM: Record<number, number> = { 2025: 51000, 2026: 55000, 2027: 57000 }
const DEPENDANT_RELIEF = 25000
const RISK_DUTY = 36
/** Monthly taxable income up to which 25.5 % applies. */
const INCOME_TAX_BAND = 877500

/** cents × permille-style rate, rounded half up, in integers. */
const share = (cents: number, numerator: number, denominator: number) => Math.floor((cents * numerator + denominator / 2) / denominator)

export interface Payroll {
  gross: number
  /** Employer 23.59 % + employee 10.5 %: the report's "Iemaksas". */
  socialTotal: number
  socialEmployee: number
  incomeTax: number
  riskDuty: number
  net: number
}

export function payroll(gross: number, year: number, opts: { dependants?: number; taxBook?: boolean; riskDuty?: boolean } = {}): Payroll {
  const cents = Math.round(gross * 100)
  const employee = share(cents, 105, 1000)
  let relief = 0
  if (opts.taxBook !== false) {
    const minimum = NON_TAXABLE_MINIMUM[year]
    if (minimum == null) throw new Error(`No non-taxable minimum known for ${year}`)
    relief = minimum + DEPENDANT_RELIEF * (opts.dependants ?? 0)
  }
  const taxable = Math.max(cents - employee - relief, 0)
  if (taxable > INCOME_TAX_BAND) throw new Error('Taxable income is above the 25.5 % band; the higher rate is not implemented')
  const tax = share(taxable, 255, 1000)
  return {
    gross: cents / 100,
    socialTotal: share(cents, 3409, 10000) / 100,
    socialEmployee: employee / 100,
    incomeTax: tax / 100,
    riskDuty: opts.riskDuty === false ? 0 : RISK_DUTY / 100,
    net: (cents - employee - tax) / 100,
  }
}

// ---------------------------------------------------------------- working-time norm

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
/** 0 = Monday … 6 = Sunday. */
const weekday = (date: string) => (new Date(`${date}T00:00:00`).getDay() + 6) % 7

/** Gregorian Easter Sunday (anonymous algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const m = (32 + 2 * e + 2 * i - h - k) % 7
  const n = Math.floor((a + 11 * h + 22 * m) / 451)
  const x = h + m - 7 * n + 114
  return iso(year, Math.floor(x / 31), (x % 31) + 1)
}

/**
 * The year's holidays by law, and the extra days off: the Monday given when 4 May or 18 November falls on a
 * weekend is a day off, but not a holiday whose eve is shortened.
 */
export function holidays(year: number, extra: string[] = []): { holidays: Set<string>; daysOff: Set<string> } {
  const easter = easterSunday(year)
  const days = new Set([
    iso(year, 1, 1),
    addDays(easter, -2),
    easter,
    addDays(easter, 1),
    iso(year, 5, 1),
    iso(year, 5, 4),
    iso(year, 6, 23),
    iso(year, 6, 24),
    iso(year, 11, 18),
    iso(year, 12, 24),
    iso(year, 12, 25),
    iso(year, 12, 26),
    iso(year, 12, 31),
    ...extra.filter((d) => d.startsWith(`${year}-`)),
  ])
  const daysOff = new Set<string>()
  for (const d of [iso(year, 5, 4), iso(year, 11, 18)]) {
    const wd = weekday(d)
    if (wd >= 5) daysOff.add(addDays(d, 7 - wd))
  }
  return { holidays: days, daysOff }
}

/** Normal working hours of a month ("YYYY-MM"): 8 per working day, 7 on the working day before a holiday. */
export function normHours(month: string, extraHolidays: string[] = []): number {
  const [year, m] = month.split('-').map(Number)
  const thisYear = holidays(year, extraHolidays)
  const all = new Set([...thisYear.holidays, ...holidays(year + 1, extraHolidays).holidays])
  let hours = 0
  for (let date = iso(year, m, 1); date.startsWith(month); date = addDays(date, 1)) {
    if (weekday(date) >= 5 || all.has(date) || thisYear.daysOff.has(date)) continue
    hours += all.has(addDays(date, 1)) ? 7 : 8
  }
  return hours
}

/** Whole tracked hours (half an hour rounds up) plus the administrative hours, never above the norm. */
export function reportedHours(trackedMinutes: number, adminHours: number, norm: number): number {
  return Math.min(Math.round(trackedMinutes / 60) + adminHours, norm)
}

// ---------------------------------------------------------------- the report

export interface EmployerReport {
  /** "YYYY-MM" */
  month: string
  trackedMinutes: number
  adminHours: number
  norm: number
  /** min(rounded tracked + admin, norm) */
  suggestedHours: number
  /** What goes into the document: the suggestion, or the owner's own figure. */
  hours: number
  capped: boolean
  pay: Payroll
}

export function buildEmployerReport(input: { month: string; trackedMinutes: number; settings: EmployerSettings; hours?: number }): EmployerReport {
  const { month, trackedMinutes, settings } = input
  const adminHours = settings.adminHours ?? DEFAULT_ADMIN_HOURS
  const norm = settings.normHours?.[month] ?? normHours(month, settings.extraHolidays)
  const suggestedHours = reportedHours(trackedMinutes, adminHours, norm)
  return {
    month,
    trackedMinutes,
    adminHours,
    norm,
    suggestedHours,
    hours: input.hours ?? suggestedHours,
    capped: Math.round(trackedMinutes / 60) + adminHours > norm,
    pay: payroll(settings.gross, Number(month.slice(0, 4)), { dependants: settings.dependants, taxBook: settings.taxBook, riskDuty: settings.riskDuty }),
  }
}

/** What is still missing before a report can be built. */
export function missingSettings(s: Partial<EmployerSettings> | undefined): string[] {
  const need: [keyof EmployerSettings, string][] = [
    ['taxpayerNo', 'company registration number'],
    ['personalCode', 'personal code'],
    ['employeeName', 'employee name'],
    ['gross', 'gross salary'],
  ]
  return need.filter(([k]) => !s?.[k]).map(([, label]) => label)
}

const money = (n: number) => n.toFixed(2)
const xml = (s: string | number) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const nil = (tag: string) => `<${tag} xsi:nil="true" />`

/** The DokDDZv5 document as EDS exports it, without the Id and UID that EDS assigns. */
export function buildDdzXml(settings: EmployerSettings, report: EmployerReport): string {
  const { pay } = report
  const [year, month] = report.month.split('-')
  const row = [
    `<PersonasKods>${xml(settings.personalCode)}</PersonasKods>`,
    `<VardsUzvards>${xml(settings.employeeName)}</VardsUzvards>`,
    `<Statuss>${xml(settings.status ?? 'DN')}</Statuss>`,
    `<Ienakumi>${money(pay.gross)}</Ienakumi>`,
    `<Iemaksas>${money(pay.socialTotal)}</Iemaksas>`,
    nil('PrecizetieIenakumi'),
    '<PrecizetasIemaksas>0.00</PrecizetasIemaksas>',
    `<IeturetaisNodoklis>${money(pay.incomeTax)}</IeturetaisNodoklis>`,
    `<DarbaVeids>${xml(settings.workType ?? '1')}</DarbaVeids>`,
    `<RiskaNodevasPazime>${pay.riskDuty > 0}</RiskaNodevasPazime>`,
    `<RiskaNodeva>${money(pay.riskDuty)}</RiskaNodeva>`,
    nil('IemaksuDatums'),
    `<Stundas>${report.hours}</Stundas>`,
    nil('PensijuIemaksas'),
    nil('SolidaritatesNodoklis'),
    nil('PrecizetasPensijuIemaksas'),
    nil('PrecizetaisSolidaritatesNodoklis'),
    '<IenakumiIzmaksatiSkaidraNauda>false</IenakumiIzmaksatiSkaidraNauda>',
  ]
  const emptyTabs = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16].map((i) => `<Tab${i} />`)
  const body = [
    '<Precizejums>false</Precizejums>',
    `<NmrKods>${xml(settings.taxpayerNo)}</NmrKods>`,
    `<ParskGads>${year}</ParskGads>`,
    `<ParskMen>${month}</ParskMen>`,
    '<NeveiktKontroles>false</NeveiktKontroles>',
    `<Epasts>${xml(settings.email)}</Epasts>`,
    `<Talrunis>${xml(settings.phone)}</Talrunis>`,
    `<Sagatavotajs>${xml(settings.preparedBy)}</Sagatavotajs>`,
    '<Tab1>',
    '  <R>',
    ...row.map((l) => `    ${l}`),
    '  </R>',
    '</Tab1>',
    ...emptyTabs,
    '<Pielikumi />',
    `<Ienakumi>${money(pay.gross)}</Ienakumi>`,
    `<Iemaksas>${money(pay.socialTotal)}</Iemaksas>`,
    '<PrecizetieIenakumi>0</PrecizetieIenakumi>',
    '<PrecizetasIemaksas>0.00</PrecizetasIemaksas>',
    `<IeturetaisNodoklis>${money(pay.incomeTax)}</IeturetaisNodoklis>`,
    `<RiskaNodeva>${money(pay.riskDuty)}</RiskaNodeva>`,
    '<PensijuIemaksas>0</PensijuIemaksas>',
    '<SolidaritatesNodoklis>0</SolidaritatesNodoklis>',
    '<PrecizetasPensijuIemaksas>0</PrecizetasPensijuIemaksas>',
    '<PrecizetaisSolidaritatesNodoklis>0</PrecizetaisSolidaritatesNodoklis>',
  ]
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<DokDDZv5 xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    ...body.map((l) => `  ${l}`),
    '</DokDDZv5>',
    '',
  ].join('\n')
}

/** The same document as the EDS API takes it (DDZv5Model): one row in table 1 and the totals. */
export function buildDdzModel(settings: EmployerSettings, report: EmployerReport): Record<string, unknown> {
  const { pay } = report
  return {
    Precizejums: false,
    NmrKods: settings.taxpayerNo,
    ParskGads: Number(report.month.slice(0, 4)),
    ParskMen: report.month.slice(5, 7),
    NeveiktKontroles: false,
    Epasts: settings.email,
    Talrunis: settings.phone,
    Sagatavotajs: settings.preparedBy,
    Tabula1: [
      {
        PersonasKods: settings.personalCode,
        VardsUzvards: settings.employeeName,
        Statuss: settings.status ?? 'DN',
        Ienakumi: pay.gross,
        Iemaksas: pay.socialTotal,
        PrecizetasIemaksas: 0,
        IeturetaisNodoklis: pay.incomeTax,
        DarbaVeids: settings.workType ?? '1',
        RiskaNodevasPazime: pay.riskDuty > 0,
        RiskaNodeva: pay.riskDuty,
        Stundas: report.hours,
        IenakumiIzmaksatiSkaidraNauda: false,
      },
    ],
    Ienakumi: pay.gross,
    Iemaksas: pay.socialTotal,
    PrecizetieIenakumi: 0,
    PrecizetasIemaksas: 0,
    IeturetaisNodoklis: pay.incomeTax,
    RiskaNodeva: pay.riskDuty,
    PensijuIemaksas: 0,
    SolidaritatesNodoklis: 0,
    PrecizetasPensijuIemaksas: 0,
    PrecizetaisSolidaritatesNodoklis: 0,
  }
}

/** "DDZ_2026-10.xml" */
export function ddzFileName(month: string): string {
  return `DDZ_${month}.xml`
}
