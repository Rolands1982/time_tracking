import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.describe.configure({ mode: 'serial' })

async function addClient(page: Page, name: string, rate: string) {
  await page.getByRole('link', { name: 'Clients' }).click()
  await page.getByRole('link', { name: '+ Add' }).click()
  await page.getByLabel(/^Name/).fill(name)
  await page.getByLabel('Hourly rate', { exact: true }).fill(rate)
  await page.getByTestId('save-client').click()
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible()
  await expect(clientLink(page, name)).toBeVisible()
}

/** The client's row on the Clients screen (other screens also show the client name). */
function clientLink(page: Page, name: string) {
  return page.locator('.card.tight').getByRole('link', { name: new RegExp(`^${name}\\b`) })
}

test('track time with the timer, add an entry, import Excel and see reports', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  // No ECB rates in the test: the fetch runs in the background after an Upwork import and its toast would
  // replace whichever message the test is waiting for at that moment.
  await page.route(/api\.frankfurter\.dev/, (route) => route.abort())
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Time tracking' })).toBeVisible()

  // Create a client and run the timer.
  await addClient(page, 'Acme', '80')
  await page.getByRole('link', { name: 'Timer' }).click()
  await page.getByLabel('Client').selectOption({ label: 'Acme' })
  await page.getByPlaceholder('Comments (optional)').fill('Testing the timer')
  await page.getByTestId('start').click()
  await expect(page.getByTestId('elapsed')).toBeVisible()
  await page.waitForTimeout(1500)
  await page.getByTestId('stop').click()
  await expect(page.getByText(/Saved 1m for Acme/)).toBeVisible()
  await expect(page.getByText('Testing the timer')).toBeVisible()

  // Timer survives a reload while running.
  await page.getByTestId('start').click()
  await expect(page.getByTestId('elapsed')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('elapsed')).toBeVisible()
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByTestId('start')).toBeVisible()

  // A rate change from the first of this month: entries before it keep the old rate.
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthLabel = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  await page.getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible()
  await clientLink(page, 'Acme').click()
  await page.getByRole('button', { name: '+ Rate change from a date' }).click()
  await page.getByLabel('Valid from').fill(`${ym}-01`)
  await page.getByLabel('Rate', { exact: true }).fill('90')
  await page.getByTestId('save-client').click()
  await expect(page.getByText('Client saved')).toBeVisible()
  await expect(page.getByText(/Today's rate: €90\.00\/h/)).toBeVisible()

  // Manual entry with all fields, dated in the current month so the Entries screen shows it by default.
  await page.getByRole('link', { name: 'Timer' }).click()
  await page.getByRole('link', { name: '+ Add entry' }).click()
  await page.getByLabel('Date').fill('2020-01-15')
  await expect(page.getByLabel('Hourly rate')).toHaveValue('80')
  await page.getByLabel('Date').fill(`${ym}-05`)
  await expect(page.getByLabel('Hourly rate')).toHaveValue('90')
  await page.getByLabel('Start time').fill('22:00')
  await page.getByLabel('End time').fill('00:30')
  await expect(page.getByText('Duration 2h 30m (ends after midnight)')).toBeVisible()
  await page.getByLabel('Project').selectOption({ label: '+ New project…' })
  await page.getByPlaceholder('New project name').fill('Website')
  await page.getByPlaceholder('New project name').press('Enter')
  await expect(page.getByLabel('Project')).toHaveValue(/\d+/)
  await page.getByLabel('Comments').fill('Night shift')
  await page.getByLabel('Is billed').check()
  await page.getByLabel('Invoice date').fill(`${ym}-28`)
  await page.getByTestId('save-entry').click()
  await expect(page.getByText('Entry saved')).toBeVisible()

  // Entries list for the current month shows the entry with project and billed badge.
  await page.getByRole('link', { name: 'Entries' }).click()
  await expect(page.getByText(monthLabel)).toBeVisible()
  await expect(page.getByText('Acme · Website')).toBeVisible()
  await expect(page.getByText('22:00–00:30 · Night shift')).toBeVisible()

  // Import the fixture workbook.
  const fixturePath = join(tmpdir(), 'Working_schedule_Polystylex.xlsx')
  // Generated in a child process: Playwright's module loader cannot load ExcelJS directly.
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/make-fixture.ts', fixturePath], { stdio: 'inherit' })
  await page.getByRole('link', { name: 'Data' }).click()
  await page.getByLabel('Excel file').setInputFiles(fixturePath)
  await expect(page.getByLabel('Client for this file')).toHaveValue('Polystylex')
  await page.getByRole('button', { name: 'Analyse file' }).click()
  await expect(page.getByText(/16 entries found in 6 sheets/)).toBeVisible()
  await page.getByTestId('confirm-import').click()
  await expect(page.getByText(/Imported 15 entries/).first()).toBeVisible()

  // Re-importing the same file adds nothing.
  await page.getByLabel('Excel file').setInputFiles(fixturePath)
  await page.getByRole('button', { name: 'Analyse file' }).click()
  await page.getByTestId('confirm-import').click()
  await expect(page.getByText(/Imported 0 entries \(16 duplicates skipped\)/)).toBeVisible()

  // Upwork pull (synthetic) imported through the Data screen: timeless daily entries.
  const upworkPath = join(tmpdir(), 'upwork-pull.json')
  await writeFile(
    upworkPath,
    JSON.stringify({
      app: 'time-tracking-upwork',
      version: 1,
      account: { name: 'Test freelancer' },
      contracts: [{ id: '36599829', title: 'RPA Developer', status: 'ACTIVE', clientOrganization: { id: '425281712378155008', name: 'Northwind Supply' } }],
      time: [{ contract: { id: '36599829', title: 'RPA Developer' }, dateWorkedOn: `${ym}-06`, weekWorkedOn: `${ym}-06`, totalHoursWorked: 6.5, totalCharges: 520, memo: 'RDEV-46', termId: '42838462' }],
      transactions: [
        { recordId: '960041226', accountingSubtype: 'Hourly', type: 'APInvoice', description: `(36599829) Northwind Supply - 6:30 hrs @ $80.00/hr - ${ym.slice(5, 7)}/06/${ym.slice(0, 4)} - ${ym.slice(5, 7)}/12/${ym.slice(0, 4)}`, transactionAmount: { currency: 'USD', rawValue: '520.00' }, transactionCreationDate: `${ym}-12T00:00:00+0000`, assignmentCompanyName: 'Northwind Supply' },
        { recordId: '960041233', accountingSubtype: 'Service Fee', type: 'APAdjustment', description: 'Service Fee\nContract ID: 42838462\nContract title: RPA Developer\nClient: Northwind Supply\nAmount: \n$520.00 USD x 10% = $52.00 USD\nNotes: n', transactionAmount: { currency: 'USD', rawValue: '-52.00' }, transactionCreationDate: `${ym}-12T00:00:00+0000`, assignmentCompanyName: 'Northwind Supply' },
        { recordId: '961135619', accountingSubtype: 'Withdrawal', type: 'APPayment', description: 'Withdrawal - Direct to Local Bank Transfer: xxxx-9485', transactionAmount: { currency: 'USD', rawValue: '467.01' }, transactionCreationDate: `${ym}-19T00:00:00+0000` },
        { recordId: '961135620', accountingSubtype: 'Withdrawal Fee', type: 'APAdjustment', description: 'Withdrawal Fee - Direct to Local Bank', transactionAmount: { currency: 'USD', rawValue: '-0.99' }, transactionCreationDate: `${ym}-19T00:00:00+0000` },
        { recordId: '970000001', accountingSubtype: 'Fixed Price', type: 'APInvoice', description: 'Invoice for RPA Developer: Milestone 1 - Setup', transactionAmount: { currency: 'USD', rawValue: '200.00' }, transactionCreationDate: `${ym}-20T00:00:00+0000`, assignmentCompanyName: 'Northwind Supply' },
      ],
    }),
  )
  await page.getByLabel('Upwork import file').setInputFiles(upworkPath)
  await expect(page.getByText(/1 contracts, 1 time rows, 5 transactions/)).toBeVisible()
  await page.getByTestId('upwork-import').click()
  await expect(page.getByText(/Upwork: 1 new rows/)).toBeVisible()
  await expect(page.getByText('Upwork days')).toBeVisible()
  // The fixed-price milestone has no hours: estimate them on the milestones screen.
  await page.getByTestId('upwork-milestones').click()
  await expect(page.getByTestId('milestone')).toHaveCount(1)
  await page.getByLabel('Hours for Milestone 1 - Setup').fill('2')
  await page.getByTestId('milestone-add').click()
  await expect(page.getByText(/Milestone 1 - Setup: 2 h entered/)).toBeVisible()
  await expect(page.getByText('Every milestone and bonus has its entry.')).toBeVisible()
  await page.getByRole('link', { name: 'Entries' }).click()
  await expect(page.getByText('2h estimated · Milestone 1 - Setup')).toBeVisible()
  await page.getByRole('link', { name: 'Entries' }).click()
  await expect(page.getByText('Northwind Supply · RPA Developer').first()).toBeVisible()
  await expect(page.getByText('6h 30m logged · RDEV-46')).toBeVisible()

  // Payouts: the bank received 421.20 EUR for the 468 USD payout (withdrawal + fee), rate 0.9; the week's
  // entry (520 gross, 52 fee from the fee row) becomes 421.20 EUR net and is no longer an estimate.
  await page.getByRole('link', { name: 'Data' }).click()
  await page.getByTestId('upwork-payouts').click()
  await expect(page.getByRole('heading', { name: 'Upwork payouts' })).toBeVisible()
  // A bank export prices the payout first (420 EUR → rate 0.8974), then the amount is corrected by hand.
  const bankPath = join(tmpdir(), 'bank-credits.csv')
  await writeFile(bankPath, `Date,Amount,Party,Description\n${ym}-21,420.00,UPWORK,PAYMENT ESCROW INC\n${ym}-22,15.00,RIMI,groceries\n`)
  await page.getByLabel('Bank credits file').setInputFiles(bankPath)
  await expect(page.getByText(/1 credits matched \(0 already priced\), 0 without a payout/)).toBeVisible()
  await page.getByTestId('bank-apply').click()
  await expect(page.getByText(/1 payouts priced from bank-credits.csv/)).toBeVisible()
  await expect(page.getByRole('cell', { name: '0.8974' })).toBeVisible()
  const eur = page.getByLabel(`EUR received for payout ${ym}-19`)
  await eur.fill('421.20')
  await eur.press('Enter')
  // The milestone (invoiced after the payout) stays an estimate until a later payout covers it.
  await expect(page.getByText(/Payout .* saved: 1 entries updated, 1 still estimated/)).toBeVisible()
  await expect(page.getByRole('cell', { name: '0.9000' })).toBeVisible()

  // Reports: all-time view shows both clients and an open balance for Polystylex.
  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('button', { name: 'All' }).click()
  await expect(page.getByRole('cell', { name: /Polystylex \(/ })).toBeVisible()
  // Non-billable work is left out of the hours unless asked for: the fixture has one non-billable hour,
  // and the 1-minute timer recording from the start of this test is non-billable too (under 7 minutes).
  const hoursBefore = Number(await page.getByTestId('report-hours').textContent())
  await page.getByTestId('include-non-billable').check()
  await expect(page.getByTestId('report-hours')).toHaveText((hoursBefore + 61 / 60).toFixed(2))
  await page.getByTestId('include-non-billable').uncheck()
  // Without a client filter everything is net in EUR: the Upwork week counts as 421.20 and the milestone, not paid
  // out yet, is estimated at the last payout's rate (200 × 0.9 = 179.49). With the Upwork client selected, gross
  // (520 + 200), net (468 + 200) and net EUR stand side by side.
  await expect(page.getByRole('cell', { name: /Northwind Supply/ }).first().locator('xpath=following-sibling::td[2]')).toHaveText('€600.69')
  await page.getByLabel('Client').selectOption({ label: 'Northwind Supply' })
  const northwind = page.getByTestId('report-group').filter({ hasText: 'Northwind Supply' }).first()
  await expect(northwind).toContainText('720.00')
  await expect(northwind).toContainText('668.00')
  await expect(northwind).toContainText('€600.69')
  await page.getByLabel('Client').selectOption({ label: 'All clients' })
  await page.getByRole('button', { name: 'Mark billed' }).first().click()
  await expect(page.getByText(/entries marked as billed/)).toBeVisible()

  // Monthly hours report: the month's hours, exported as Excel.
  await page.getByTestId('monthly-report').click()
  await expect(page.getByRole('heading', { name: 'Monthly hours' })).toBeVisible()
  await expect(page.getByTestId('monthly-hours')).toHaveText(/^\d+\.\d\d$/)
  await expect(page.getByTestId('monthly-whole-hours')).toHaveText(/^\d+ h$/)
  const monthly = page.waitForEvent('download')
  await page.getByTestId('monthly-xlsx').click()
  expect((await monthly).suggestedFilename()).toMatch(/^Hours_\d{4}-\d{2}\.xlsx$/)

  // Other income: a rent row recorded as of the end of the week, added to the billed work in Reports.
  await page.locator('.bottom-nav').getByRole('link', { name: 'Reports' }).click()
  await page.getByTestId('other-income-link').click()
  await expect(page.getByRole('heading', { name: 'Other income' })).toBeVisible()
  await page.getByTestId('income-date').fill('2026-10-04')
  await page.getByTestId('income-type').fill('Rent')
  await page.getByTestId('income-amount').fill('320')
  await page.getByTestId('income-save').click()
  await page.getByRole('button', { name: 'All' }).click()
  await expect(page.getByTestId('income-total')).toHaveText(/320/)
  await expect(page.getByTestId('income-row')).toHaveCount(1)
  await page.locator('.topbar').getByRole('link', { name: 'Reports' }).click()
  await expect(page.getByTestId('report-income-Rent')).toHaveText(/320/)
  await expect(page.getByTestId('report-total-income')).toHaveText(/\d/)

  // Master export downloads an .xlsx file.
  await page.getByRole('link', { name: 'Data' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export master Excel file' }).click()
  expect((await download).suggestedFilename()).toMatch(/^Master_time_tracking_\d{4}-\d{2}-\d{2}\.xlsx$/)

  // Customer summary for one client and period, exported as Excel and as PDF.
  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('button', { name: 'All' }).click()
  await page.getByRole('link', { name: 'Customer summary (Excel / PDF)' }).click()
  await expect(page.getByRole('heading', { name: 'Customer summary' })).toBeVisible()
  await page.getByLabel('Client').selectOption({ label: 'Polystylex' })
  await expect(page.getByTestId('summary-hours')).toHaveText(/^\d+\.\d\d$/)
  await page.getByTestId('toggle-columns').click()
  await page.locator('.chips').getByRole('button', { name: /Rate/ }).click()
  await expect(page.getByTestId('toggle-columns')).toHaveText(/7 of 11/)
  await expect(page.getByTestId('preview-table').locator('thead th')).toHaveText(['Date', 'Time', 'Project', 'Description', 'Hours', 'Amount', 'Invoice'])
  await page.locator('.chips').getByRole('button', { name: /Category/ }).click()
  await expect(page.getByTestId('preview-table').locator('thead th')).toHaveText(['Date', 'Time', 'Project', 'Category', 'Description', 'Hours', 'Amount', 'Invoice'])
  await page.getByRole('button', { name: 'Excel', exact: true }).click()
  const xlsx = page.waitForEvent('download')
  await page.getByTestId('summary-download').click()
  expect((await xlsx).suggestedFilename()).toBe('Summary_Polystylex_all.xlsx')
  await page.getByRole('button', { name: 'PDF', exact: true }).click()
  const pdf = page.waitForEvent('download')
  await page.getByTestId('summary-download').click()
  const pdfFile = await pdf
  expect(pdfFile.suggestedFilename()).toBe('Summary_Polystylex_all.pdf')
  expect((await readFile((await pdfFile.path())!)).subarray(0, 5).toString()).toBe('%PDF-')

  // E-mail opens a compose form with the client's details, the summary text and the attachment.
  await page.getByTestId('summary-email').click()
  const compose = page.getByTestId('compose')
  await expect(compose.getByLabel('Subject')).toHaveValue('Time summary Polystylex – All time')
  await expect(compose.getByLabel('Message')).toHaveValue(/please find attached the time summary for All time/)
  await expect(compose.getByText(/Attachment: .*Summary_Polystylex_all\.pdf/)).toBeVisible()
  await compose.getByLabel('To').fill('client@example.lv')
  await compose.getByRole('button', { name: 'Cancel' }).click()
  await expect(compose).toHaveCount(0)
})
