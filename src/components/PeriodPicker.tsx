import { periodLabel, stepAnchor, type Period, type PeriodState } from '../lib/period'

const PERIODS: Period[] = ['month', 'quarter', 'year', 'all', 'custom']

export default function PeriodPicker({ value, onChange }: { value: PeriodState; onChange: (next: PeriodState) => void }) {
  return (
    <>
      <div className="segmented">
        {PERIODS.map((p) => (
          <button key={p} type="button" className={value.period === p ? 'active' : ''} onClick={() => onChange({ ...value, period: p })}>
            {p[0].toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>
      {(value.period === 'month' || value.period === 'quarter' || value.period === 'year') && (
        <div className="month-nav">
          <button type="button" className="btn" onClick={() => onChange({ ...value, anchor: stepAnchor(value, -1) })} aria-label="Previous period">
            ‹
          </button>
          <strong>{periodLabel(value)}</strong>
          <button type="button" className="btn" onClick={() => onChange({ ...value, anchor: stepAnchor(value, 1) })} aria-label="Next period">
            ›
          </button>
        </div>
      )}
      {value.period === 'custom' && (
        <div className="grid-2">
          <label className="field">
            <span>From</span>
            <input type="date" value={value.custom.from} onChange={(e) => onChange({ ...value, custom: { ...value.custom, from: e.target.value } })} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={value.custom.to} onChange={(e) => onChange({ ...value, custom: { ...value.custom, to: e.target.value } })} />
          </label>
        </div>
      )}
    </>
  )
}
