import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { db, DEFAULT_SETTINGS } from './schema'
import type { Client, Project, Settings } from './types'

export function useSettings(): Settings {
  return useLiveQuery(async () => (await db.settings.get('app')) ?? DEFAULT_SETTINGS, [], DEFAULT_SETTINGS)
}

export function useClients(includeArchived = false): Client[] {
  const all = useLiveQuery(() => db.clients.orderBy('name').toArray(), [], [] as Client[])
  return useMemo(() => (includeArchived ? all : all.filter((c) => !c.archived)), [all, includeArchived])
}

export function useProjects(clientId?: number, includeArchived = false): Project[] {
  const all = useLiveQuery(() => db.projects.toArray(), [], [] as Project[])
  return useMemo(
    () =>
      all
        .filter((p) => (clientId == null ? true : p.clientId === clientId))
        .filter((p) => includeArchived || !p.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [all, clientId, includeArchived],
  )
}

/** Lookup maps for rendering lists quickly. */
export function useLookups() {
  const clients = useClients(true)
  const projects = useProjects(undefined, true)
  return useMemo(
    () => ({
      clients,
      projects,
      clientById: new Map(clients.map((c) => [c.id!, c])),
      projectById: new Map(projects.map((p) => [p.id!, p])),
      clientName: (id?: number) => (id == null ? '' : (clients.find((c) => c.id === id)?.name ?? '?')),
      projectName: (id?: number) => (id == null ? '' : (projects.find((p) => p.id === id)?.name ?? '?')),
    }),
    [clients, projects],
  )
}
