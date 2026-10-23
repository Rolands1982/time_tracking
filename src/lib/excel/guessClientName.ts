/** Guess a client name from a file name such as "Working_schedule_Polystylex.xlsx". */
export function guessClientName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{8}-/i, '')
  const parts = base.split(/[_\-\s]+/).filter(Boolean)
  const noise = new Set(['working', 'schedule', 'time', 'tracking', 'timesheet', 'hours', 'copy', 'of', 'stundu', 'uzskaite', 'stundas'])
  const candidates = parts.filter((p) => !noise.has(p.toLowerCase()) && !/^\d+$/.test(p))
  return (candidates.length ? candidates : parts).join(' ').trim() || 'Client'
}
