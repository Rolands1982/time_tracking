import { useState } from 'react'
import { useClients, useProjects } from '../db/hooks'
import { findOrCreateClient, findOrCreateProject } from '../db/repo'

interface Props {
  clientId?: number
  projectId?: number
  onChange: (next: { clientId?: number; projectId?: number }) => void
  /** Default rate for a client created inline. */
  newClientRate?: number
}

const NEW = '__new__'

/** Client + project selects with an inline "new…" option for both. */
export default function ClientProjectPicker({ clientId, projectId, onChange, newClientRate = 0 }: Props) {
  const clients = useClients()
  const projects = useProjects(clientId)
  const [newClient, setNewClient] = useState<string | null>(null)
  const [newProject, setNewProject] = useState<string | null>(null)

  const commitClient = async () => {
    const name = newClient?.trim()
    if (!name) return setNewClient(null)
    const c = await findOrCreateClient(name, { defaultRate: newClientRate })
    setNewClient(null)
    onChange({ clientId: c.id, projectId: undefined })
  }
  const commitProject = async () => {
    const name = newProject?.trim()
    if (!name || clientId == null) return setNewProject(null)
    const p = await findOrCreateProject(clientId, name)
    setNewProject(null)
    onChange({ clientId, projectId: p.id })
  }

  return (
    <div className="grid-2">
      <label className="field">
        <span>Client</span>
        {newClient == null ? (
          <select
            value={clientId ?? ''}
            onChange={(e) => {
              if (e.target.value === NEW) setNewClient('')
              else onChange({ clientId: e.target.value ? Number(e.target.value) : undefined, projectId: undefined })
            }}
          >
            <option value="">— select —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NEW}>+ New client…</option>
          </select>
        ) : (
          <input
            autoFocus
            placeholder="New client name"
            value={newClient}
            onChange={(e) => setNewClient(e.target.value)}
            onBlur={commitClient}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commitClient())}
          />
        )}
      </label>
      <label className="field">
        <span>Project</span>
        {newProject == null ? (
          <select
            value={projectId ?? ''}
            disabled={clientId == null}
            onChange={(e) => {
              if (e.target.value === NEW) setNewProject('')
              else onChange({ clientId, projectId: e.target.value ? Number(e.target.value) : undefined })
            }}
          >
            <option value="">— none —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW}>+ New project…</option>
          </select>
        ) : (
          <input
            autoFocus
            placeholder="New project name"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            onBlur={commitProject}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commitProject())}
          />
        )}
      </label>
    </div>
  )
}
