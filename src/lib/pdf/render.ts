import type { TDocumentDefinitions } from 'pdfmake/interfaces'

export const ROBOTO = {
  Roboto: { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' },
}

/** Browser only: load pdfmake and its fonts on demand and render a document definition to a Blob. */
export async function renderPdf(def: TDocumentDefinitions): Promise<Blob> {
  const [pdfModule, vfsModule] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')])
  const pdfMake = (pdfModule as unknown as { default?: typeof pdfModule }).default ?? pdfModule
  const vfs = (vfsModule as unknown as { default?: Record<string, string> }).default ?? (vfsModule as unknown as Record<string, string>)
  pdfMake.addVirtualFileSystem(vfs)
  pdfMake.addFonts(ROBOTO)
  return pdfMake.createPdf(def).getBlob()
}
