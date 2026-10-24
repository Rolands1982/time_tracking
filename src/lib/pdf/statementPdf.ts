/**
 * Customer summary as a PDF (pdfmake, loaded on demand together with the Roboto font so
 * Latvian and other Latin Extended characters render).
 */
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { FILTER_LABELS, hours, type Statement } from '../statement'
import { formatDate } from '../period'

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

  const body: TableCell[][] = [
    [head('Date'), head('Time'), head('Project'), head('Description'), head('Hours', 'right'), head('Rate', 'right'), head('Amount', 'right'), head('Invoice')],
  ]
  for (const r of st.rows) {
    const muted = r.billable ? {} : { color: GREY, italics: true }
    body.push([
      { text: formatDate(r.date), ...muted },
      { text: `${r.startTime}–${r.endTime}`, ...muted },
      { text: r.project, ...muted },
      { text: [r.category, r.comments].filter(Boolean).join(': '), ...muted },
      { text: num(hours(r.minutes)), ...right, ...muted },
      { text: r.billable ? num(r.rate) : '', ...right, ...muted },
      { text: r.billable ? num(r.amount) : '–', ...right, ...muted },
      { text: !r.billable ? 'non-billable' : r.isBilled ? (r.invoiceRef ?? (r.invoiceDate ? formatDate(r.invoiceDate) : 'billed')) : 'open', ...muted },
    ])
  }
  body.push([
    { text: 'Total', style: 'total', colSpan: 4 },
    {},
    {},
    {},
    { text: num(hours(st.minutes)), style: 'total', ...right },
    { text: '', style: 'total' },
    { text: money(st.amount, st.currency), style: 'total', ...right },
    { text: '', style: 'total' },
  ])

  const content: Content[] = [
    { text: 'Time summary', style: 'eyebrow' },
    { text: st.clientName, style: 'title' },
    { text: `Period: ${st.periodLabel}`, margin: [0, 0, 0, 2] },
    { text: `${FILTER_LABELS[st.filter]} · generated ${formatDate(st.generatedAt)}`, color: GREY, margin: [0, 0, 0, 14] },
    {
      table: {
        widths: ['*', '*', '*'],
        body: [
          [
            { stack: [{ text: 'Total hours', style: 'statLabel' }, { text: num(hours(st.minutes)), style: 'statValue' }] },
            { stack: [{ text: 'Total amount', style: 'statLabel' }, { text: money(st.amount, st.currency), style: 'statValue' }] },
            { stack: [{ text: 'Entries', style: 'statLabel' }, { text: String(st.count), style: 'statValue' }] },
          ],
        ],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => '#f3f4f6', paddingTop: () => 8, paddingBottom: () => 8, paddingLeft: () => 10, paddingRight: () => 10 },
      margin: [0, 0, 0, 16],
    },
    {
      table: { headerRows: 1, widths: [52, 58, 'auto', '*', 34, 34, 50, 'auto'], body, dontBreakRows: true },
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
    content.push({ text: 'By project', style: 'h2', margin: [0, 18, 0, 6] })
    content.push({
      table: {
        headerRows: 1,
        widths: ['*', 50, 40, 70],
        body: [
          [head('Project'), head('Entries', 'right'), head('Hours', 'right'), head('Amount', 'right')],
          ...st.byProject.map((g) => [g.name, { text: String(g.count), ...right }, { text: num(hours(g.minutes)), ...right }, { text: money(g.amount, st.currency), ...right }]),
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

export const ROBOTO = {
  Roboto: { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' },
}

/** Browser only: load pdfmake and its fonts on demand and render the summary to a Blob. */
export async function statementPdfBlob(st: Statement): Promise<Blob> {
  const [pdfModule, vfsModule] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')])
  const pdfMake = (pdfModule as unknown as { default?: typeof pdfModule }).default ?? pdfModule
  const vfs = (vfsModule as unknown as { default?: Record<string, string> }).default ?? (vfsModule as unknown as Record<string, string>)
  pdfMake.addVirtualFileSystem(vfs)
  pdfMake.addFonts(ROBOTO)
  return pdfMake.createPdf(statementDocDefinition(st)).getBlob()
}
