import { useState } from 'react'
import { useSync } from '../sync/useSync'
import { useToast } from './toastContext'

/** The "Cloud sync" section of the Data screen: configuration, sign-in and sync status. */
export default function CloudSyncCard() {
  const sync = useSync()
  const toast = useToast()
  const [url, setUrl] = useState(sync.config?.url ?? '')
  const [anonKey, setAnonKey] = useState(sync.config?.anonKey ?? '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingConfig, setEditingConfig] = useState(!sync.configured)

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const saveConfig = () => {
    const u = url.trim().replace(/\/+$/, '')
    const k = anonKey.trim()
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u) && !/^https?:\/\//.test(u)) return toast('Enter the project URL, e.g. https://abcd1234.supabase.co')
    if (!k) return toast('Enter the anon (public) key')
    sync.configure({ url: u, anonKey: k })
    setEditingConfig(false)
    toast('Cloud sync configured')
  }

  return (
    <>
      <h2>Cloud sync</h2>
      <div className="card stack" data-testid="cloud-sync">
        {!sync.configured || editingConfig ? (
          <>
            <p className="muted small">
              Keeps the same data on every device and makes it available to reports and invoicing. Create a free project at
              supabase.com, run <code>supabase/schema.sql</code> from the repository in its SQL editor, then paste the
              project URL and the anon key (Project settings → API).
            </p>
            <label className="field">
              <span>Supabase project URL</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" inputMode="url" autoCapitalize="off" />
            </label>
            <label className="field">
              <span>Anon (public) key</span>
              <input value={anonKey} onChange={(e) => setAnonKey(e.target.value)} placeholder="eyJ…" autoCapitalize="off" />
            </label>
            <div className="actions">
              {sync.configured && (
                <button className="btn" onClick={() => setEditingConfig(false)}>
                  Cancel
                </button>
              )}
              <button className="btn primary" onClick={saveConfig}>
                Save
              </button>
            </div>
          </>
        ) : !sync.ready ? (
          <p className="muted">Connecting…</p>
        ) : !sync.user ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              void guard(() => sync.signIn(email, password))
            }}
          >
            <p className="muted small">
              Sign in with the account that owns your data. The first time, create the account; the same e-mail and password
              then work on every device.
            </p>
            <label className="field">
              <span>E-mail</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" minLength={6} required />
            </label>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  guard(async () => {
                    const signedIn = await sync.signUp(email, password)
                    toast(signedIn ? 'Account created' : 'Account created – confirm the e-mail we sent you, then sign in')
                  })
                }
              >
                Create account
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                Sign in
              </button>
            </div>
            {!sync.builtIn && (
              <button type="button" className="btn ghost small" onClick={() => setEditingConfig(true)}>
                Change project settings
              </button>
            )}
          </form>
        ) : (
          <>
            <div className="row between">
              <div>
                <div>
                  <strong>{sync.user.email}</strong>
                </div>
                <div className="muted small">
                  {sync.syncing
                    ? 'Syncing…'
                    : sync.lastSyncAt
                      ? `Last sync ${new Date(sync.lastSyncAt).toLocaleString()}`
                      : 'Not synced yet'}
                  {sync.pending > 0 ? ` · ${sync.pending} local change${sync.pending === 1 ? '' : 's'} waiting` : ''}
                  {!sync.online ? ' · offline' : ''}
                </div>
                {sync.lastError && <div className="error">Last error: {sync.lastError}</div>}
              </div>
              <span className="badge" style={{ background: sync.pending ? 'color-mix(in srgb, var(--warning) 18%, transparent)' : 'color-mix(in srgb, var(--success) 18%, transparent)' }}>
                {sync.pending ? 'pending' : 'in sync'}
              </span>
            </div>
            <div className="actions">
              <button className="btn" disabled={busy} onClick={() => guard(() => sync.signOut())}>
                Sign out
              </button>
              <button
                className="btn primary"
                disabled={busy || sync.syncing || !sync.online}
                onClick={() =>
                  guard(async () => {
                    const r = await sync.syncNow()
                    toast(r ? `Synced: ${r.pushed} pushed, ${r.deleted} deleted, ${r.pulled} pulled` : 'Nothing to sync')
                  })
                }
              >
                Sync now
              </button>
            </div>
            {!sync.builtIn && (
              <button type="button" className="btn ghost small" onClick={() => setEditingConfig(true)}>
                Change project settings
              </button>
            )}
          </>
        )}
      </div>
    </>
  )
}
