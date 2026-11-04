import { syncNow } from './useSync'

/**
 * Bring the cloud's latest rows in before deriving anything from them (an import, a payout edit, a
 * recalculation). Settlement is computed from the ledger and cached on the entries, and a device that has
 * not synced for a while would otherwise push stale results over fresher ones, since the newer write wins.
 * Signed out or offline: nothing happens and the caller carries on with the local copy.
 */
export async function pullLatest(): Promise<boolean> {
  try {
    return (await syncNow()) != null
  } catch {
    return false
  }
}
