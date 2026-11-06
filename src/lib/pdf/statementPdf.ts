/**
 * Customer summary as a PDF (pdfmake, loaded on demand together with the Roboto font so
 * Latvian and other Latin Extended characters render).
 */
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { describe, FILTER_LABELS, hours, invoiceText, timeText, type Statement, type StatementColumn, type StatementRow } from '../statement'
import { formatDate } from '../period'
import { renderPdf } from './render'

const GREY = '#6b7280'
const LINE = '#d1d5db'

function money(n: number, currency: string): string {
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

const num = (n: number) => n.toFixed(2)

/** Pure document definition; rendering happens in statementPdfBlob / the tests. */
export function statementDocDefinition(st: Statement): TDocumentDefinitions {
  const right = { alignment: 'right' as const }
  const head = (text: string, align?: 'right') => ({ text, style: 'th', ...(align ? right : {}) })

  type Spec = { header: string; width: string | number; align?: 'right'; cell: (r: StatementRow) => string }
  const specs: Record<StatementColumn, Spec> = {
    date: { header: 'Date', width: 52, cell: (r) => formatDate(r.date) },
    time: { header: 'Time', width: 58, cell: (r) => timeText(r) },
    project: { header: 'Project', width: 'auto', cell: (r) => r.project },
    category: { header: 'Category', width: 'auto', cell: (r) => r.category ?? '' },
    description: { header: 'Description', width: '*', cell: (r) => describe(r, st.columns) },
    hours: { header: 'Hours', width: 34, align: 'right', cell: (r) => num(hours(r.minutes)) },
    rate: { header: 'Rate', width: 34, align: 'right', cell: (r) => (r.billable ? num(r.rate) : '') },
    amount: { header: 'Amount', width: 50, align: 'right', cell: (r) => (r.billable ? num(r.amount) : '–') },
    net: { header: 'Net', width: 50, align: 'right', cell: (r) => (r.billable ? num(r.netAmount) : '–') },
    netEur: { header: 'Net EUR', width: 50, align: 'right', cell: (r) => (r.billable ? (r.netAmountEur != null ? num(r.netAmountEur) : '?') : '–') },
    invoice: { header: 'Invoice', width: 'auto', cell: (r) => invoiceText(r, formatDate) },
  }
  const cols = st.columns.map((key) => ({ key, ...specs[key] }))
  // Without a stretching column the table would hug its content; let the last text column grow.
  if (!cols.some((c) => c.width === '*')) {
    const grow = cols.find((c) => c.key === 'project' || c.key === 'category' || c.key === 'invoice') ?? cols[cols.length - 1]
    grow.width = '*'
  }

  const body: TableCell[][] = [cols.map((c) => head(c.header, c.align))]
  for (const r of st.rows) {
    const muted = r.billable ? {} : { color: GREY, italics: true }
    body.push(cols.map((c) => ({ text: c.cell(r), ...(c.align ? right : {}), ...muted })))
  }
  body.push(
    cols.map((c, i) => {
      const text =
        i === 0
          ? 'Total'
          : c.key === 'hours'
            ? num(hours(st.minutes))
            : c.key === 'amount'
              ? money(st.amount, st.currency)
              : c.key === 'net'
                ? money(st.netAmount, st.currency)
                : c.key === 'netEur'
                  ? money(st.netAmountEur, 'EUR')
                  : ''
      return { text, style: 'total', ...(c.align ? right : {}) }
    }),
  )

  const stat = (label: string, value: string) => ({ stack: [{ text: label, style: 'statLabel' }, { text: value, style: 'statValue' }] })
  const stats = [
    stat('Total hours', num(hours(st.minutes))),
    stat('Total amount', money(st.amount, st.currency)),
    ...(st.columns.includes('net') ? [stat('Net after fees', money(st.netAmount, st.currency))] : []),
    ...(st.columns.includes('netEur') ? [stat(st.eurMissing ? 'Net EUR (partly estimated)' : 'Net EUR', money(st.netAmountEur, 'EUR'))] : []),
    stat('Entries', String(st.count)),
  ]
  const content: Content[] = [
    { text: 'Time summary', style: 'eyebrow' },
    { text: st.clientName, style: 'title' },
    { text: `Period: ${st.periodLabel}`, margin: [0, 0, 0, 2] },
    { text: `${FILTER_LABELS[st.filter]} · generated ${formatDate(st.generatedAt)}`, color: GREY, margin: [0, 0, 0, 14] },
    {
      table: {
        widths: stats.map(() => '*'),
        body: [stats],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => '#f3f4f6', paddingTop: () => 8, paddingBottom: () => 8, paddingLeft: () => 10, paddingRight: () => 10 },
      margin: [0, 0, 0, 16],
    },
    {
      table: { headerRows: 1, widths: cols.map((c) => c.width), body, dontBreakRows: true },
      layout: {
        hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 0 || i === 1 || i >= node.table.body.length - 1 ? 0.8 : 0.3),
        vLineWidth: () => 0,
        hLineColor: () => LINE,
        paddingTop: () => 3,
        paddingBottom: () => 3,
      },
    },
  ]
  if (st.nonBillableCount) {
    content.push({
      text: `${st.nonBillableCount} non-billable ${st.nonBillableCount === 1 ? 'entry' : 'entries'} (${num(hours(st.nonBillableMin))} h) are listed for information and not charged.`,
      color: GREY,
      margin: [0, 8, 0, 0],
    })
  }
  if (st.byProject.length > 1) {
    const withNet = st.columns.includes('net')
    const withEur = st.columns.includes('netEur')
    content.push({ text: 'By project', style: 'h2', margin: [0, 18, 0, 6] })
    content.push({
      table: {
        headerRows: 1,
        widths: ['*', 50, 40, 70, ...(withNet ? [70] : []), ...(withEur ? [70] : [])],
        body: [
          [head('Project'), head('Entries', 'right'), head('Hours', 'right'), head('Amount', 'right'), ...(withNet ? [head('Net', 'right')] : []), ...(withEur ? [head('Net EUR', 'right')] : [])],
          ...st.byProject.map((g) => [
            g.name,
            { text: String(g.count), ...right },
            { text: num(hours(g.minutes)), ...right },
            { text: money(g.amount, st.currency), ...right },
            ...(withNet ? [{ text: money(g.netAmount, st.currency), ...right }] : []),
            ...(withEur ? [{ text: money(g.netAmountEur, 'EUR'), ...right }] : []),
          ]),
        ],
      },
      layout: { hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.3), vLineWidth: () => 0, hLineColor: () => LINE, paddingTop: () => 3, paddingBottom: () => 3 },
    })
  }

  return {
    info: { title: `Time summary – ${st.clientName} – ${st.periodLabel}`, author: 'Time Tracking app' },
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
        { text: `${st.clientName} · ${st.periodLabel}`, color: GREY, fontSize: 7.5 },
        { text: `Page ${page} of ${pages}`, alignment: 'right', color: GREY, fontSize: 7.5 },
      ],
      margin: [36, 16, 36, 0],
    }),
    content,
  }
}

export { ROBOTO } from './render'

/** Browser only: load pdfmake and its fonts on demand and render the summary to a Blob. */
export function statementPdfBlob(st: Statement): Promise<Blob> {
  return renderPdf(statementDocDefinition(st))
}
