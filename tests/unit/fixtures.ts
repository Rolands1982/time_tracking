/**
 * Builds an in-memory workbook that mimics the real "Working schedule" files:
 *  - sheet 1: 2018 layout without Project column, rate 60 in the Earned formula, dates carried down
 *  - sheet 2: 2019 layout with Project column, end time at Excel 24:00 (1900-01-01)
 *  - sheet 3: "Support" layout with Category + "When billed?" columns, rate 50, header on row 2
 *  - sheet 4: a sheet without a time table (ignored)
 */
import ExcelJS from 'exceljs'

const t = (h: number, m = 0) => new Date(Date.UTC(1899, 11, 30, h, m))
const midnight = new Date(Date.UTC(1900, 0, 1))
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day))

export async function buildFixtureWorkbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()

  const s1 = wb.addWorksheet('October')
  s1.addRow(['Date', 'From ', 'Till', 'Total hours', 'Earned', 'What is done?'])
  s1.addRow([d(2018, 10, 1), t(14), t(15), { formula: '(C2-B2)*24', result: 1 }, { formula: 'D2*60', result: 60 }, 'Sales variance analysis'])
  s1.addRow([null, t(16, 30), t(18, 30), { formula: '(C3-B3)*24', result: 2 }, { formula: 'D3*60', result: 120 }, 'Power BI update'])
  s1.addRow([null, t(21, 30), midnight, { formula: '(C4-B4)*24', result: 2.5 }, { formula: 'D4*60', result: 150 }, 'Account plans'])
  s1.addRow([d(2018, 10, 2), t(12), t(12, 30), 1, 60, 'Typed hours override (1h instead of 30m)'])
  s1.addRow([null, null, null, { formula: '(C6-B6)*24' }, { formula: 'D6*60' }])
  s1.addRow(['Total', null, null, { formula: 'SUM(D2:D6)' }, { formula: 'SUM(E2:E6)' }])

  const s2 = wb.addWorksheet('Jan 2019')
  s2.addRow(['Date', 'From ', 'Till', 'Total hours', 'Earned', 'Project', 'What is done?'])
  s2.addRow([d(2019, 1, 2), t(18, 30), t(20, 30), { formula: '(C2-B2)*24', result: 2 }, { formula: 'D2*60', result: 120 }, 'VPS', 'Vessel grouping'])
  s2.addRow([d(2019, 1, 2), t(23), midnight, { formula: '(C3-B3)*24', result: 1 }, { formula: 'D3*60', result: 60 }, 'VPS', 'Segmentation'])
  s2.addRow([d(2019, 1, 3), t(14), t(17), { formula: '(C4-B4)*24', result: 3 }, { formula: 'D4*60', result: 180 }, 'ETAS', 'Initial analysis'])
  // Duplicate of the row above – must be collapsed on import.
  s2.addRow([d(2019, 1, 3), t(14), t(17), { formula: '(C5-B5)*24', result: 3 }, { formula: 'D5*60', result: 180 }, 'ETAS', 'Initial analysis'])

  const s3 = wb.addWorksheet('Support')
  s3.addRow([])
  s3.addRow([null, 'Date', 'From ', 'Till', 'Total hours', 'Earned', 'What is done?', 'Category', 'When billed?'])
  s3.addRow([null, d(2023, 6, 21), t(14), t(15), { formula: 'IF(ISBLANK(C3), "",(D3-C3)*24)', result: 1 }, { formula: 'IF(ISBLANK(C3),"",E3*50)', result: 50 }, 'Bug fixes', 'Support', 'Billed 01/10/2023'])
  s3.addRow([null, d(2023, 7, 28), t(22), t(22, 30), { formula: 'IF(ISBLANK(C4), "",(D4-C4)*24)', result: 0.5 }, { formula: 'IF(ISBLANK(C4),"",E4*50)', result: 25 }, 'Small changes', 'Izstrāde', null])
  s3.addRow([null, d(2023, 8, 10), '13:00', '13:15', 0.25, 12.5, 'String times', 'Support', 'yes'])

  const s4 = wb.addWorksheet('Notes')
  s4.addRow(['Just some notes'])

  // Latvian headers, invoice column with month labels / "Nepiestādāmas", project stage as category.
  const s5 = wb.addWorksheet('Uzskaite')
  s5.addRow(['Datums', 'Gads', 'Mēnesis', 'No ', 'Līdz', 'Stundas kopā', 'Summa (EUR)', 'Kas tika izdarīts', 'Projekts', 'Projekta stadija', 'Projektu vadītājs', 'Rēķins'])
  s5.addRow([d(2023, 6, 13), { formula: 'YEAR(A2)', result: 2023 }, { formula: 'MONTH(A2)', result: 6 }, t(13, 30), t(14), { formula: 'IF(ISBLANK(D2), "",(E2-D2)*24)', result: 0.5 }, { formula: 'IF(ISBLANK(D2),"",F2*50)', result: 25 }, 'Sapulce', 'Locitech', 'Izpēte', 'Ivo', 'Jūnijs 2023'])
  s5.addRow([d(2023, 6, 14), { formula: 'YEAR(A3)', result: 2023 }, { formula: 'MONTH(A3)', result: 6 }, t(15), t(16), { formula: 'IF(ISBLANK(D3), "",(E3-D3)*24)', result: 1 }, { formula: 'IF(ISBLANK(D3),"",F3*50)', result: 50 }, 'Izstrāde', 'Fazer', 'Izstrāde', 'Karina', 'Nepiestādāmas'])
  s5.addRow([d(2023, 6, 15), { formula: 'YEAR(A4)', result: 2023 }, { formula: 'MONTH(A4)', result: 6 }, t(9), t(9, 30), { formula: 'IF(ISBLANK(D4), "",(E4-D4)*24)', result: 0.5 }, { formula: 'IF(ISBLANK(D4),"",F4*50)', result: 25 }, 'Atvērts', 'Fazer', 'Atbalsts', 'Ivo', null])

  // Money formula under the "Total hours" header, no Earned column: rate must come from *24*80.
  const s6 = wb.addWorksheet('ViVi')
  s6.addRow(['Date', 'From ', 'Till', null, 'Total hours', 'What is done?'])
  s6.addRow([d(2026, 10, 7), t(11), t(12), { formula: '(C2-B2)*24', result: 1 }, { formula: '(C2-B2)*24*80', result: 80 }, 'Power Automate'])

  // Later engagement layout: "Amount (EUR)" and "Job description" headers, From/To, helper Gads/Mēnesis columns.
  const s7 = wb.addWorksheet('Details')
  s7.addRow(['Date', 'Gads', 'Mēnesis', 'From', 'To', 'Total hours', 'Amount (EUR)', 'Job description', 'Project'])
  s7.addRow([d(2024, 3, 22), null, null, t(17), t(17, 30), { formula: 'IF(ISBLANK(D2), "",(E2-D2)*24)', result: 0.5 }, { formula: 'IF(ISBLANK(D2),"",F2*70)', result: 35 }, 'Initial meeting', 'POC'])

  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}
