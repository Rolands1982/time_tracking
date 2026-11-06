/** externalId conventions of Upwork entries (shared by the importer, the settlement and the milestones screen). */
export const MILESTONE_PREFIX = 'upwork:milestone:'

export function milestoneKey(txId: string): string {
  return `${MILESTONE_PREFIX}${txId}`
}

/** The invoice row id of a milestone entry, or undefined for every other entry. */
export function milestoneTxId(externalId: string | undefined): string | undefined {
  return externalId?.startsWith(MILESTONE_PREFIX) ? externalId.slice(MILESTONE_PREFIX.length) : undefined
}
