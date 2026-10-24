/** Hand a generated file to another app (share sheet) or start an e-mail to the client. */

export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false
  try {
    return navigator.canShare({ files: [new File([new Blob(['x'])], 'probe.pdf', { type: 'application/pdf' })] })
  } catch {
    return false
  }
}

export type ShareResult = 'shared' | 'cancelled' | 'unsupported'

/** Opens the system share sheet with the file attached. Resolves 'cancelled' when the user dismisses it. */
export async function shareFile(data: Blob, fileName: string, type: string, text: { title: string; body: string }): Promise<ShareResult> {
  if (!canShareFiles()) return 'unsupported'
  const file = new File([data], fileName, { type })
  try {
    await navigator.share({ files: [file], title: text.title, text: text.body })
    return 'shared'
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    throw err
  }
}

/** mailto: link with the recipient, subject and body filled in (attachments cannot be added this way). */
export function mailtoLink(to: string | undefined, subject: string, body: string): string {
  const params = new URLSearchParams({ subject, body })
  return `mailto:${encodeURIComponent(to ?? '')}?${params.toString().replace(/\+/g, '%20')}`
}
