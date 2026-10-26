import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.describe.configure({ mode: 'serial' })

async function addClient(page: Page, name: string, rate: string) {
  await page.getByRole('link', { name: 'Clients' }).click()
  await page.getByRole('link', { name: '+ Add' }).click()
  await page.getByLabel(/^Name/).fill(name)
  await page.getByLabel('Hourly rate', { exact: true }).fill(rate)
  await page.getByTestId('save-client').click()
  await expect(page.getByText(name, { exact: true })).toBeVisible()
}

test('track time with the timer, add an entry, import Excel and see reports', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
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
  await page.getByText('Acme', { exact: true }).click()
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

  // Reports: all-time view shows both clients and an open balance for Polystylex.
  await page.getByRole('link', { name: 'Reports' }).click()
  await page.getByRole('button', { name: 'All' }).click()
  await expect(page.getByRole('cell', { name: /Polystylex \(/ })).toBeVisible()
  await page.getByRole('button', { name: 'Mark billed' }).first().click()
  await expect(page.getByText(/entries marked as billed/)).toBeVisible()

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
  await expect(page.getByTestId('toggle-columns')).toHaveText(/7 of 9/)
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
