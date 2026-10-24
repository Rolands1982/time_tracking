import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.describe.configure({ mode: 'serial' })

async function addClient(page: Page, name: string, rate: string) {
  await page.getByRole('link', { name: 'Clients' }).click()
  await page.getByRole('button', { name: '+ Add' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Hourly rate').fill(rate)
  await page.getByRole('button', { name: 'Save' }).click()
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

  // Manual entry with all fields, dated in the current month so the Entries screen shows it by default.
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const monthLabel = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  await page.getByRole('link', { name: '+ Add entry' }).click()
  await page.getByLabel('Date').fill(`${ym}-05`)
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
})
