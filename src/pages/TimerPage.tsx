import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useNavigate } from 'react-router-dom'
import ClientProjectPicker from '../components/ClientProjectPicker'
import { useToast } from '../components/toastContext'
import { useLookups, useSettings } from '../db/hooks'
import { billedMinutes, cancelTimer, effectiveRate, startTimer, stopTimer, timerRecording, totals, updateTimer } from '../db/repo'
import { db } from '../db/schema'
import { formatDuration, formatElapsed, formatMoney, todayIso } from '../lib/time'

/** Draft for a timer that has not been started. `null` means the user explicitly cleared the field. */
interface Draft {
  clientId?: number | null
  projectId?: number | null
  comments: string
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export default function TimerPage() {
  const settings = useSettings()
  const timer = settings.runningTimer
  const { clientById, projectById, clientName, projectName } = useLookups()
  const toast = useToast()
  const navigate = useNavigate()

  const [draft, setDraft] = useState<Draft>({ comments: '' })
  // Until the user touches the picker, pre-select the client used last time.
  const draftClientId = draft.clientId === undefined ? settings.lastClientId : (draft.clientId ?? undefined)
  const draftProjectId = draft.clientId === undefined ? settings.lastProjectId : (draft.projectId ?? undefined)

  const now = useNow(Boolean(timer))

  const activeClientId = timer ? timer.clientId : draftClientId
  const activeProjectId = timer ? timer.projectId : draftProjectId
  const rate = effectiveRate(
    activeClientId != null ? clientById.get(activeClientId) : undefined,
    activeProjectId != null ? projectById.get(activeProjectId) : undefined,
  )
  const currency = (activeClientId != null && clientById.get(activeClientId)?.currency) || settings.defaultCurrency

  const today = todayIso()
  const todayEntries = useLiveQuery(() => db.entries.where('date').equals(today).toArray(), [today], [])
  const todayTotals = useMemo(() => totals(todayEntries), [todayEntries])

  const onStart = async () => {
    if (draftClientId == null) return toast('Choose a client first')
    await startTimer({ clientId: draftClientId, projectId: draftProjectId, comments: draft.comments })
  }
  const onStop = async () => {
    if (!timer || timer.clientId == null) return toast('Choose a client before stopping')
    const id = await stopTimer({ clientId: timer.clientId, projectId: timer.projectId, hourlyRate: rate, comments: timer.comments })
    const entry = id != null ? await db.entries.get(id) : undefined
    toast(entry ? `Saved ${formatDuration(entry.durationMin)} for ${clientName(entry.clientId)}` : 'Timer stopped')
    setDraft({ clientId: timer.clientId, projectId: timer.projectId ?? null, comments: '' })
    if (entry && !entry.comments) navigate(`/entries/${id}`)
  }
  const onCancel = async () => {
    if (confirm('Discard the running timer?')) await cancelTimer()
  }

  const elapsed = timer ? Math.max(0, now - new Date(timer.startedAt).getTime()) : 0
  const recording = timer ? timerRecording(new Date(timer.startedAt), new Date(now)) : null
  const normalize = settings.roundingMode !== 'exact'
  const previewMin = recording ? (normalize ? recording.billedMin : recording.actualMin) : 0

  return (
    <>
      <div className="topbar">
        <h1>Time tracking</h1>
        <Link to="/entries/new" className="btn small">
          + Add entry
        </Link>
      </div>

      <div className="card">
        {timer ? (
          <>
            <div className="row" style={{ justifyContent: 'center' }}>
              <span className="pulse" />{' '}
              <span className="muted small">
                Running since {new Date(timer.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="timer-display" data-testid="elapsed">
              {formatElapsed(elapsed)}
            </div>
            <p className="muted small" style={{ textAlign: 'center' }}>
              {recording && normalize
                ? `Billed as ${recording.billedStartTime}–${recording.billedEndTime} · ${formatDuration(recording.billedMin)}${recording.billable ? '' : ' (non-billable)'}`
                : recording
                  ? `Recorded as ${formatDuration(recording.actualMin)}`
                  : ''}
              {rate > 0 ? ` · ${formatMoney((previewMin / 60) * rate, currency)}` : ' · no hourly rate set for this client'}
            </p>
            <div className="stack">
              <ClientProjectPicker clientId={timer.clientId} projectId={timer.projectId} onChange={(next) => updateTimer(next)} />
              <label className="field">
                <span>What are you working on?</span>
                <textarea value={timer.comments} onChange={(e) => updateTimer({ comments: e.target.value })} placeholder="Comments" />
              </label>
            </div>
            <div className="actions">
              <button className="btn danger" onClick={onCancel}>
                Discard
              </button>
              <button className="btn primary big" onClick={onStop} data-testid="stop">
                ■ Stop &amp; save
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="timer-display muted">00:00:00</div>
            <div className="stack">
              <ClientProjectPicker
                clientId={draftClientId}
                projectId={draftProjectId}
                onChange={(next) => setDraft((d) => ({ ...d, clientId: next.clientId ?? null, projectId: next.projectId ?? null }))}
              />
              <label className="field">
                <span>What are you working on?</span>
                <textarea
                  value={draft.comments}
                  onChange={(e) => setDraft((d) => ({ ...d, comments: e.target.value }))}
                  placeholder="Comments (optional)"
                />
              </label>
              <p className="muted small">
                {draftClientId != null
                  ? rate > 0
                    ? `Rate: ${formatMoney(rate, currency)}/h`
                    : 'This client has no hourly rate yet – set it under Clients.'
                  : 'Pick a client (or create one) to start.'}
              </p>
            </div>
            <button className="btn primary big block" onClick={onStart} data-testid="start" disabled={draftClientId == null}>
              ▶ Start timer
            </button>
          </>
        )}
      </div>

      <div className="row between">
        <h2>Today</h2>
        <span className="muted small mono">
          {formatDuration(todayTotals.durationMin)} · {formatMoney(todayTotals.amount, currency)}
        </span>
      </div>
      <div className="card tight">
        {todayEntries.length === 0 ? (
          <div className="empty">Nothing tracked today yet.</div>
        ) : (
          [...todayEntries]
            .sort((a, b) => a.startTime.localeCompare(b.startTime))
            .map((e) => (
              <Link key={e.id} to={`/entries/${e.id}`} className="list-item">
                <div className="grow">
                  <div className="title">
                    {clientName(e.clientId)}
                    {e.projectId != null ? ` · ${projectName(e.projectId)}` : ''}
                  </div>
                  <div className="sub">
                    {e.startTime}–{e.endTime}
                    {e.comments ? ` · ${e.comments}` : ''}
                  </div>
                </div>
                <div className="right nowrap mono">
                  <div>
                    {formatDuration(billedMinutes(e))}
                    {billedMinutes(e) !== e.durationMin && <span className="muted small"> ({formatDuration(e.durationMin)})</span>}
                  </div>
                  <div className="muted small">{formatMoney(e.amount, clientById.get(e.clientId)?.currency)}</div>
                </div>
              </Link>
            ))
        )}
      </div>
    </>
  )
}
