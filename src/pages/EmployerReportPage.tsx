import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useSearchParams } from 'react-router-dom'
import { useToast } from '../components/toastContext'
import { useSettings } from '../db/hooks'
import { totals } from '../db/repo'
import { db, updateSettings } from '../db/schema'
import type { TimeEntry } from '../db/types'
import { downloadBlob } from '../lib/download'
import { callEds, canSubmit, diagnoseEds, isSubmitted, messagesOf, type EdsDiagnosis, type EdsDocument } from '../lib/eds'
import { buildDdzModel, buildDdzXml, buildEmployerReport, ddzFileName, DEFAULT_ADMIN_HOURS, missingSettings, type EmployerReport, type EmployerSettings } from '../lib/employerReport'
import { addMonths, formatMoney, monthLabel, monthRange, todayIso } from '../lib/time'

const EMPTY: EmployerSettings = { taxpayerNo: '', email: '', phone: '', preparedBy: '', personalCode: '', employeeName: '', gross: 0, dependants: 0, adminHours: DEFAULT_ADMIN_HOURS }

/**
 * Monthly employer's report (Darba devēja ziņojums): hours from the tracker plus the administrative hours,
 * capped at the month's norm; the payroll figures from the fixed gross salary; as an XML file for EDS, or sent
 * to EDS, checked and submitted through the `eds` function.
 */
export default function EmployerReportPage() {
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const settings = useSettings()
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : addMonths(todayIso().slice(0, 7), -1)
  const setMonth = (m: string) => {
    setParams({ month: m }, { replace: true })
    setHoursText(null)
    setDoc(null)
    setProblem(null)
  }

  const range = monthRange(`${month}-01`)
  const entries = useLiveQuery(() => db.entries.where('date').between(range.from, range.to, true, true).toArray(), [range.from, range.to], [] as TimeEntry[])
  const trackedMinutes = useMemo(() => totals(entries).billedMin, [entries])

  const employer = settings.employerReport
  const missing = missingSettings(employer)
  const [hoursText, setHoursText] = useState<string | null>(null)
  const ownHours = hoursText != null && /^\d+$/.test(hoursText.trim()) ? Number(hoursText) : undefined

  const built = useMemo((): { report?: EmployerReport; error?: string } => {
    if (!employer || missing.length) return {}
    try {
      return { report: buildEmployerReport({ month, trackedMinutes, settings: employer, hours: ownHours }) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }, [employer, missing.length, month, trackedMinutes, ownHours])
  const report = built.report

  // The EDS document of this month, remembered so it is never created twice.
  const saved = employer?.documents?.[month]
  const [doc, setDoc] = useState<EdsDocument | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [diagnosis, setDiagnosis] = useState<EdsDiagnosis | null>(null)

  const remember = async (entry: { id: number; hours: number; submitted?: boolean } | null) => {
    if (!employer) return
    const documents = { ...employer.documents }
    if (entry) documents[month] = entry
    else delete documents[month]
    await updateSettings({ employerReport: { ...employer, documents } })
  }

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name)
    setProblem(null)
    try {
      await action()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const send = () =>
    run('send', async () => {
      if (!employer || !report) return
      const out = await callEds({ action: 'send', model: buildDdzModel(employer, report), documentId: saved?.id })
      if (!out.ok) {
        setProblem(out.error)
        return
      }
      await remember({ id: out.documentId, hours: saved?.hours ?? report.hours, submitted: isSubmitted(out.document) || undefined })
      setDoc(out.document)
      if (out.warning) setProblem(`Document ${out.documentId} is in EDS, but the check did not run: ${out.warning}`)
      toast(out.created ? `Document ${out.documentId} created in EDS` : `Document ${out.documentId} checked again`)
    })

  const diagnose = () =>
    run('diagnose', async () => {
      const out = await diagnoseEds()
      if (!out.ok) {
        setProblem(out.error)
        return
      }
      setDiagnosis(out.diagnosis)
    })

  const refresh = () =>
    run('status', async () => {
      if (!saved) return
      const out = await callEds({ action: 'status', documentId: saved.id })
      if (!out.ok) {
        setProblem(out.error)
        return
      }
      setDoc(out.document)
      if (isSubmitted(out.document) && !saved.submitted) await remember({ ...saved, submitted: true })
    })

  const submit = () =>
    run('submit', async () => {
      if (!saved || !report) return
      if (!confirm(`Submit the employer's report for ${monthLabel(month)} to VID?\n\n${saved.hours} hours, income ${formatMoney(report.pay.gross, 'EUR')}.`)) return
      const out = await callEds({ action: 'submit', documentId: saved.id })
      if (!out.ok) {
        setProblem(out.error)
        if (out.document) setDoc(out.document)
        return
      }
      setDoc(out.document)
      await remember({ ...saved, submitted: true })
      toast(out.alreadySubmitted ? 'Already submitted' : 'Submitted to VID')
    })

  const remove = () =>
    run('delete', async () => {
      if (!saved) return
      if (!confirm(`Delete document ${saved.id} in EDS?`)) return
      const out = await callEds({ action: 'delete', documentId: saved.id })
      if (!out.ok) {
        setProblem(out.error)
        return
      }
      await remember(null)
      setDoc(null)
      toast('Document deleted in EDS')
    })

  /** Stop tracking a document that no longer exists in EDS (deleted there by hand). */
  const forget = async () => {
    if (!saved || !confirm(`Forget document ${saved.id}? It is not touched in EDS.`)) return
    await remember(null)
    setDoc(null)
    setProblem(null)
  }

  const downloadXml = () => {
    if (!employer || !report) return
    // Handed over as a plain file: a blob the browser could render (XML) is treated as a page to open first, and
    // newer Chrome leaves the app unresponsive after that download.
    downloadBlob(buildDdzXml(employer, report), ddzFileName(month), 'application/octet-stream')
  }

  const found = messagesOf(doc)
  const hoursChanged = Boolean(saved && report && saved.hours !== report.hours)

  return (
    <>
      <div className="topbar">
        <h1>Employer's report</h1>
        <Link className="btn small" to="/reports">
          ← Reports
        </Link>
      </div>

      <div className="card stack">
        <div className="month-nav">
          <button className="btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
            ‹
          </button>
          <strong>{monthLabel(month)}</strong>
          <button className="btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
            ›
          </button>
        </div>

        {missing.length > 0 ? (
          <p className="muted">Fill in the settings below first: {missing.join(', ')}.</p>
        ) : built.error ? (
          <p className="muted">{built.error}</p>
        ) : (
          report && (
            <>
              <div className="stat-grid">
                <div className="stat">
                  <div className="label">Hours to report</div>
                  <div className="value" data-testid="employer-hours">
                    {report.hours}
                  </div>
                  <div className="label">
                    tracked {(report.trackedMinutes / 60).toFixed(2)} + {report.adminHours} admin{report.capped ? ', capped' : ''}
                  </div>
                  <div className="label">norm {report.norm}</div>
                </div>
                <div className="stat">
                  <div className="label">Income</div>
                  <div className="value">{formatMoney(report.pay.gross, 'EUR')}</div>
                  <div className="label">net {formatMoney(report.pay.net, 'EUR')}</div>
                </div>
                <div className="stat">
                  <div className="label">Social contributions</div>
                  <div className="value" data-testid="employer-social">
                    {formatMoney(report.pay.socialTotal, 'EUR')}
                  </div>
                  <div className="label">employee part {formatMoney(report.pay.socialEmployee, 'EUR')}</div>
                </div>
                <div className="stat">
                  <div className="label">Income tax</div>
                  <div className="value">{formatMoney(report.pay.incomeTax, 'EUR')}</div>
                  <div className="label">risk duty {formatMoney(report.pay.riskDuty, 'EUR')}</div>
                </div>
              </div>
              <label className="field">
                <span>Hours in the report (leave empty for the suggestion, {report.suggestedHours})</span>
                <input type="number" inputMode="numeric" min="0" step="1" value={hoursText ?? ''} placeholder={String(report.suggestedHours)} onChange={(e) => setHoursText(e.target.value || null)} data-testid="employer-hours-input" />
              </label>
              {report.hours > report.norm && <p className="muted small">Above the month's norm of {report.norm} hours.</p>}
              <div className="actions">
                <button className="btn" onClick={downloadXml} data-testid="employer-xml">
                  ⬇ XML for EDS
                </button>
                <button className="btn primary" onClick={send} disabled={busy != null} data-testid="employer-send">
                  {busy === 'send' ? 'Sending…' : saved ? 'Check again in EDS' : 'Send to EDS and check'}
                </button>
              </div>
              <p className="muted small">
                Due by the 17th of the following month. Sending creates the document in EDS and runs its checks; nothing is submitted until
                you press Submit. The XML file is the same document for "load from file" in EDS.
              </p>
            </>
          )
        )}
      </div>

      {saved && (
        <>
          <h2>In EDS</h2>
          <div className="card stack" data-testid="employer-eds">
            <div>
              <strong>Document {saved.id}</strong>
              <span className="muted"> · {saved.hours} hours</span>
              {doc?.Statuss && <span> · {doc.Statuss}</span>}
              {(saved.submitted || isSubmitted(doc)) && <span> · submitted{doc?.Iesniegts ? ` ${doc.Iesniegts.slice(0, 10)}` : ''}</span>}
            </div>
            {hoursChanged && !saved.submitted && (
              <p className="muted small">
                The document was sent with {saved.hours} hours; the report now shows {report!.hours}. Delete it and send again to change it.
              </p>
            )}
            {found.errors.map((m) => (
              <p key={m} style={{ color: 'var(--danger)' }}>
                Error: {m}
              </p>
            ))}
            {found.warnings.map((m) => (
              <p key={m} style={{ color: 'var(--warning)' }}>
                Warning: {m}
              </p>
            ))}
            {found.info.map((m) => (
              <p key={m} className="muted small">
                {m}
              </p>
            ))}
            {(doc?.SanemtasAtbildes ?? []).map((a, i) => (
              <p key={i} className="muted small">
                {a.Datums} {a.Tips}: {a.Teksts}
              </p>
            ))}
            <div className="actions">
              <button className="btn" onClick={refresh} disabled={busy != null}>
                {busy === 'status' ? 'Reading…' : 'Refresh status'}
              </button>
              {!saved.submitted && !isSubmitted(doc) && (
                <button className="btn danger" onClick={remove} disabled={busy != null}>
                  Delete in EDS
                </button>
              )}
            </div>
            {!saved.submitted && !isSubmitted(doc) && (
              <button className="btn primary block" onClick={submit} disabled={busy != null || !canSubmit(doc)} data-testid="employer-submit">
                {busy === 'submit' ? 'Submitting…' : 'Submit to VID'}
              </button>
            )}
            {!doc && !saved.submitted && <p className="muted small">Refresh the status to see whether the document may be submitted.</p>}
            <button className="btn small" onClick={forget}>
              Forget this document
            </button>
          </div>
        </>
      )}

      {problem && (
        <div className="card" data-testid="employer-problem">
          <p style={{ color: 'var(--danger)' }}>{problem}</p>
          <button className="btn small" onClick={diagnose} disabled={busy != null} data-testid="employer-diagnose">
            {busy === 'diagnose' ? 'Checking…' : 'Check the EDS connection'}
          </button>
        </div>
      )}

      {diagnosis && (
        <div className="card stack" data-testid="employer-diagnosis">
          <strong>
            EDS connection: {diagnosis.mode === 'key' ? 'API key' : diagnosis.mode === 'certificate' ? 'API certificate' : 'no secrets'}
          </strong>
          {diagnosis.facts.map((f) => (
            <p key={f} className="muted small">
              {f}
            </p>
          ))}
          {diagnosis.problems.map((p) => (
            <p key={p} style={{ color: 'var(--danger)' }}>
              {p}
            </p>
          ))}
          {diagnosis.probe && <p style={{ color: diagnosis.probe.ok ? 'var(--success)' : 'var(--danger)' }}>{diagnosis.probe.message}</p>}
          <button className="btn small" onClick={diagnose} disabled={busy != null}>
            {busy === 'diagnose' ? 'Checking…' : 'Check again'}
          </button>
        </div>
      )}

      <SettingsCard key={employer ? 'set' : 'new'} value={employer ?? EMPTY} open={missing.length > 0} />
    </>
  )
}

function SettingsCard({ value, open }: { value: EmployerSettings; open: boolean }) {
  const toast = useToast()
  const [form, setForm] = useState({
    ...value,
    gross: value.gross ? String(value.gross) : '',
    dependants: String(value.dependants ?? 0),
    adminHours: String(value.adminHours ?? DEFAULT_ADMIN_HOURS),
  })
  const text = (key: 'taxpayerNo' | 'email' | 'phone' | 'preparedBy' | 'personalCode' | 'employeeName' | 'gross' | 'dependants' | 'adminHours', label: string, extra: Record<string, string> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} data-testid={`employer-${key}`} {...extra} />
    </label>
  )
  const save = async () => {
    const gross = Number(form.gross.replace(',', '.'))
    if (!Number.isFinite(gross) || gross <= 0) {
      toast('Enter the gross salary')
      return
    }
    await updateSettings({
      employerReport: {
        ...value,
        taxpayerNo: form.taxpayerNo.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        preparedBy: form.preparedBy.trim(),
        personalCode: form.personalCode.trim(),
        // Kept as typed: EDS writes the name with its own spacing.
        employeeName: form.employeeName,
        gross,
        dependants: Math.max(0, Math.round(Number(form.dependants) || 0)),
        adminHours: Math.max(0, Math.round(Number(form.adminHours) || 0)),
      },
    })
    toast('Settings saved')
  }
  return (
    <details open={open}>
      <summary>
        <h2 style={{ display: 'inline' }}>Company and salary</h2>
      </summary>
      <div className="card stack">
        <p className="muted small">Kept on this device only (and in its backup file); enter them once on each device you file from.</p>
        <div className="grid-2">
          {text('taxpayerNo', 'Company registration number', { inputMode: 'numeric' })}
          {text('preparedBy', 'Prepared by (name, surname)')}
          {text('email', 'E-mail', { type: 'email' })}
          {text('phone', 'Phone', { inputMode: 'tel' })}
          {text('personalCode', 'Employee personal code', { inputMode: 'numeric' })}
          {text('employeeName', 'Employee name as in EDS')}
          {text('gross', 'Gross salary per month (EUR)', { inputMode: 'decimal' })}
          {text('dependants', 'Dependants on the tax book', { inputMode: 'numeric' })}
          {text('adminHours', 'Administrative hours added per month', { inputMode: 'numeric' })}
        </div>
        <button className="btn primary" onClick={save} data-testid="employer-save">
          Save
        </button>
      </div>
    </details>
  )
}
