/** Monthly hours report as a PDF (pdfmake, loaded on demand). */
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { hoursOf, type MonthlyReport } from '../monthlyReport'
import { formatDate } from '../period'
import { renderPdf } from './render'

const GREY = '#6b7280'
const LINE = '#d1d5db'
const num = (n: number) => n.toFixed(2)
const eur = (n: number) => `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`

/** Pure document definition; rendering happens in monthlyPdfBlob / the tests. */
export function monthlyDocDefinition(r: MonthlyReport): TDocumentDefinitions {
  const right = { alignment: 'right' as const }
  const head = (text: string, align?: 'right') => ({ text, style: 'th', ...(align ? right : {}) })
  const stat = (label: string, value: string) => ({ stack: [{ text: label, style: 'statLabel' }, { text: value, style: 'statValue' }] })
  const t = r.totals
  const layout = { hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.3), vLineWidth: () => 0, hLineColor: () => LINE, paddingTop: () => 3, paddingBottom: () => 3 }

  const clientBody: TableCell[][] = [
    [head('Client'), head('Entries', 'right'), head('Hours', 'right'), head('Rounded', 'right'), head('Net EUR', 'right')],
    ...r.rows.map((row) => [
      { text: row.businessName ? `${row.name} (${row.businessName})` : row.name },
      { text: String(row.entries), ...right },
      { text: num(hoursOf(row.minutes)) + (row.estimatedHours ? ' *' : ''), ...right },
      { text: `${row.wholeHours} h`, ...right },
      { text: eur(row.netEur) + (row.estimated || row.eurMissing ? ' ~' : ''), ...right },
    ]),
    [
      { text: 'Total', style: 'total' },
      { text: String(t.entries), style: 'total', ...right },
      { text: num(hoursOf(t.minutes)), style: 'total', ...right },
      { text: `${t.wholeHours} h`, style: 'total', ...right },
      { text: eur(t.netEur), style: 'total', ...right },
    ],
  ]
  const dayBody: TableCell[][] = [
    [head('Date'), head('Hours', 'right'), head('Rounded', 'right'), head('Clients')],
    ...r.days.map((d) => [{ text: formatDate(d.date) }, { text: num(hoursOf(d.minutes)), ...right }, { text: `${d.wholeHours} h`, ...right }, { text: d.clients.join(', ') }]),
  ]

  const notes = [
    t.estimatedHours ? `* ${t.estimatedHours} ${t.estimatedHours === 1 ? 'entry' : 'entries'} with estimated hours (fixed-price work).` : '',
    t.estimated || t.eurMissing ? `~ ${t.estimated} ${t.estimated === 1 ? 'entry' : 'entries'} with an estimated fee or exchange rate${t.eurMissing ? `, ${t.eurMissing} without a rate (not in the EUR total)` : ''}.` : '',
    t.nonBillableMin ? `${num(hoursOf(t.nonBillableMin))} h of the hours are non-billable work (no money).` : '',
    'Rounded: whole hours per client or day; the total is their sum.',
  ].filter(Boolean)

  const content: Content[] = [
    { text: 'Monthly hours report', style: 'eyebrow' },
    { text: r.label, style: 'title' },
    { text: `Generated ${formatDate(r.generatedAt)} · hours on the billed basis`, color: GREY, margin: [0, 0, 0, 14] },
    {
      table: { widths: ['*', '*', '*', '*'], body: [[stat('Hours', num(hoursOf(t.minutes))), stat('Days worked', String(t.daysWorked)), stat('Entries', String(t.entries)), stat('Net EUR', eur(t.netEur))]] },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => '#f3f4f6', paddingTop: () => 8, paddingBottom: () => 8, paddingLeft: () => 10, paddingRight: () => 10 },
      margin: [0, 0, 0, 16],
    },
    { text: 'By client', style: 'h2', margin: [0, 0, 0, 6] },
    { table: { headerRows: 1, widths: ['*', 46, 50, 50, 80], body: clientBody }, layout },
    ...(notes.length ? [{ text: notes.join(' '), color: GREY, margin: [0, 8, 0, 0] as [number, number, number, number] }] : []),
    { text: 'By day', style: 'h2', margin: [0, 18, 0, 6] },
    { table: { headerRows: 1, widths: [70, 50, 50, '*'], body: dayBody, dontBreakRows: true }, layout },
  ]

  return {
    info: { title: `Monthly hours report – ${r.label}`, author: 'Time Tracking app' },
    pageSize: 'A4',
    pageMargins: [36, 40, 36, 44],
    defaultStyle: { font: 'Roboto', fontSize: 8.5, lineHeight: 1.15 },
    styles: {
      eyebrow: { fontSize: 9, color: GREY, characterSpacing: 0.5 },
      title: { fontSize: 18, bold: true, margin: [0, 2, 0, 8] },
      h2: { fontSize: 11, bold: true },
      th: { bold: true, fontSize: 8, color: GREY },
      total: { bold: true },
      statLabel: { fontSize: 8, color: GREY },
      statValue: { fontSize: 13, bold: true, margin: [0, 2, 0, 0] },
    },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `Monthly hours report · ${r.label}`, color: GREY, fontSize: 7.5 },
        { text: `Page ${page} of ${pages}`, alignment: 'right', color: GREY, fontSize: 7.5 },
      ],
      margin: [36, 16, 36, 0],
    }),
    content,
  }
}

export function monthlyPdfBlob(r: MonthlyReport): Promise<Blob> {
  return renderPdf(monthlyDocDefinition(r))
}
