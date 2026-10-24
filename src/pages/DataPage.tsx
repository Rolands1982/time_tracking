import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import CloudSyncCard from '../components/CloudSyncCard'
import { useToast } from '../components/toastContext'
import { useSettings } from '../db/hooks'
import { db, updateSettings } from '../db/schema'
import { findDuplicates, removeDuplicates } from '../db/repo'
import { clearAllData, createBackup, isBackup, restoreBackup } from '../lib/backup'
import type { ImportSummary } from '../lib/excel/importIntoDb'
import { guessClientName } from '../lib/excel/guessClientName'
import type { ParseResult } from '../lib/excel/importWorkbook'
import { downloadBlob, stamp, XLSX_MIME } from '../lib/download'

export default function DataPage() {
  const toast = useToast()
  const settings = useSettings()
  const counts = useLiveQuery(
    async () => ({ entries: await db.entries.count(), clients: await db.clients.count(), projects: await db.projects.count() }),
    [],
    { entries: 0, clients: 0, projects: 0 },
  )
  const duplicates = useLiveQuery(() => findDuplicates(), [], { entries: 0, projects: 0 })

  const [file, setFile] = useState<File | null>(null)
  const [clientName, setClientName] = useState('')
  const [defaultRate, setDefaultRate] = useState('')
  const [billedBefore, setBilledBefore] = useState('')
  const [preview, setPreview] = useState<ParseResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  // Remount the file input after an import so the same file can be chosen again.
  const [inputKey, setInputKey] = useState(0)

  const onPick = (f: File | null) => {
    setFile(f)
    setPreview(null)
    setSummary(null)
    if (f) setClientName(guessClientName(f.name))
  }

  const analyse = async () => {
    if (!file) return
    setBusy(true)
    try {
      const { parseWorkbook, applyBilledBefore } = await import('../lib/excel/importWorkbook')
      const data = await file.arrayBuffer()
      const result = await parseWorkbook(data, { clientName: clientName.trim() || 'Client', defaultRate: Number(defaultRate) || 0 })
      if (billedBefore) {
        const n = applyBilledBefore(result.entries, billedBefore)
        if (n) result.warnings.unshift(`${n} rows before ${billedBefore} marked as billed (their sheets have no billing column)`)
      }
      setPreview(result)
      if (!result.entries.length) toast('No entries recognised in this file')
    } catch (err) {
      toast(`Could not read file: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const doImport = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const { importEntries } = await import('../lib/excel/importIntoDb')
      const s = await importEntries(preview.entries)
      setSummary(s)
      toast(`Imported ${s.added} entries${s.duplicates ? `, ${s.duplicates} already present` : ''}`)
      setPreview(null)
      setFile(null)
      setInputKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }

  const exportMaster = async () => {
    setBusy(true)
    try {
      const [entries, clients, projects] = await Promise.all([db.entries.toArray(), db.clients.toArray(), db.projects.toArray()])
      const { masterWorkbookToBuffer } = await import('../lib/excel/exportMaster')
      const buf = await masterWorkbookToBuffer({ entries, clients, projects })
      downloadBlob(buf, `Master_time_tracking_${stamp()}.xlsx`, XLSX_MIME)
    } finally {
      setBusy(false)
    }
  }

  const backup = async () => {
    const b = await createBackup()
    downloadBlob(JSON.stringify(b), `time-tracking-backup_${stamp()}.json`, 'application/json')
  }

  const restore = async (f: File | null) => {
    if (!f) return
    try {
      const parsed: unknown = JSON.parse(await f.text())
      if (!isBackup(parsed)) throw new Error('not a backup file')
      if (!confirm(`Replace all local data with this backup (${parsed.entries.length} entries)?`)) return
      await restoreBackup(parsed)
      toast('Backup restored')
    } catch (err) {
      toast(`Restore failed: ${(err as Error).message}`)
    }
  }

  const wipe = async () => {
    if (!confirm('Delete ALL entries, clients and projects? With cloud sync on, the next sync removes them from the cloud as well. Export a backup first.')) return
    if (!confirm('Really delete everything?')) return
    await clearAllData()
    toast('All data deleted')
  }

  const dedupe = async () => {
    const n = duplicates.entries + duplicates.projects
    if (!confirm(`Remove ${duplicates.entries} duplicate entries and ${duplicates.projects} duplicate projects? The oldest copy of each is kept.`)) return
    const r = await removeDuplicates()
    toast(`Removed ${r.entries} entries and ${r.projects} projects (${n} expected)`)
  }

  return (
    <>
      <div className="topbar">
        <h1>Data</h1>
        <span className="muted small">
          {counts.entries} entries · {counts.clients} clients
        </span>
      </div>

      <CloudSyncCard />

      <h2>Import Excel time sheet</h2>
      <div className="card stack">
        <p className="muted small">
          Reads the old "one sheet per month" workbooks (Date / From / Till / Earned / Project / What is done? / Category / When
          billed?) as well as the master file exported by this app. Rows already imported are skipped, so importing the same
          file twice is safe.
        </p>
        <input key={inputKey} type="file" accept=".xlsx" onChange={(e) => onPick(e.target.files?.[0] ?? null)} aria-label="Excel file" />
        {file && (
          <>
            <div className="grid-2">
              <label className="field">
                <span>Client for this file</span>
                <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
              </label>
              <label className="field">
                <span>Fallback hourly rate</span>
                <input type="number" inputMode="decimal" value={defaultRate} onChange={(e) => setDefaultRate(e.target.value)} placeholder="only if missing" />
              </label>
            </div>
            <label className="field">
              <span>Treat rows before this date as billed in their own month (sheets without a billing column)</span>
              <input type="date" value={billedBefore} onChange={(e) => setBilledBefore(e.target.value)} />
            </label>
            {!preview && (
              <button className="btn primary" onClick={analyse} disabled={busy}>
                {busy ? 'Reading…' : 'Analyse file'}
              </button>
            )}
          </>
        )}
        {preview && (
          <>
            <p>
              <strong>{preview.entries.length}</strong> entries found in {preview.sheets.filter((s) => s.imported > 0).length} sheets ·{' '}
              {(preview.entries.reduce((s, e) => s + e.durationMin, 0) / 60).toFixed(2)} h ·{' '}
              {preview.entries.reduce((s, e) => s + e.amount, 0).toFixed(2)} total ·{' '}
              {preview.entries.filter((e) => e.isBilled).length} marked billed
            </p>
            <details>
              <summary className="small muted">Sheets ({preview.sheets.length})</summary>
              <pre className="log">
                {preview.sheets.map((s) => `${s.name}: ${s.imported} rows${s.skipped ? `, ${s.skipped} skipped` : ''}${s.reason ? ` (${s.reason})` : ''}`).join('\n')}
              </pre>
            </details>
            {preview.warnings.length > 0 && (
              <details>
                <summary className="small muted">Warnings ({preview.warnings.length})</summary>
                <pre className="log">{preview.warnings.join('\n')}</pre>
              </details>
            )}
            <div className="actions">
              <button className="btn" onClick={() => setPreview(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={doImport} disabled={busy || preview.entries.length === 0} data-testid="confirm-import">
                Import {preview.entries.length} entries
              </button>
            </div>
          </>
        )}
        {summary && (
          <p className="small">
            Imported <strong>{summary.added}</strong> entries ({summary.duplicates} duplicates skipped). Clients: {summary.clients.join(', ') || '–'}.
          </p>
        )}
      </div>

      <h2>Master file</h2>
      <div className="card stack">
        <p className="muted small">One Excel file with every entry plus summaries by month, client, project and invoice.</p>
        <button className="btn primary" onClick={exportMaster} disabled={busy || counts.entries === 0}>
          ⬇ Export master Excel file
        </button>
      </div>

      <h2>Backup</h2>
      <div className="card stack">
        <p className="muted small">
          A full copy of the data as JSON. Restoring replaces everything, in the cloud too when sync is on, so restore
          on one device only; the others receive the data through sync.
        </p>
        <button className="btn" onClick={backup} disabled={counts.entries === 0 && counts.clients === 0}>
          ⬇ Download backup (.json)
        </button>
        <label className="field">
          <span>Restore from backup</span>
          <input type="file" accept="application/json,.json" onChange={(e) => restore(e.target.files?.[0] ?? null)} />
        </label>
      </div>

      <h2>Settings</h2>
      <div className="card stack">
        <div className="grid-2">
          <label className="field">
            <span>Default currency</span>
            <input value={settings.defaultCurrency} maxLength={3} onChange={(e) => updateSettings({ defaultCurrency: e.target.value.toUpperCase() })} />
          </label>
          <label className="field">
            <span>Rounding for new records</span>
            <select value={settings.roundingMode ?? 'billing'} onChange={(e) => updateSettings({ roundingMode: e.target.value as 'billing' | 'exact' })}>
              <option value="billing">Billing rules (10-min start, 15-min steps)</option>
              <option value="exact">Exact minutes</option>
            </select>
          </label>
        </div>
        <div className="row between">
          <span className="small">
            {duplicates.entries + duplicates.projects === 0
              ? 'No duplicate entries or projects.'
              : `${duplicates.entries} duplicate entries, ${duplicates.projects} duplicate projects.`}
          </span>
          <button className="btn small" onClick={dedupe} disabled={duplicates.entries + duplicates.projects === 0} data-testid="dedupe">
            Remove duplicates
          </button>
        </div>
        <button className="btn danger" onClick={wipe}>
          Delete all data
        </button>
      </div>
    </>
  )
}
