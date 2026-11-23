import { useState } from 'react'

const NEW_TYPE = '__new__'

/**
 * Type as a dropdown of every type in use (a text list with suggestions would only offer what matches the text
 * already in it), with "New type…" for one that does not exist yet. An empty value means the suggestion.
 */
export default function TypeSelect({ value, onChange, types, suggestion, testId }: { value: string; onChange: (v: string) => void; types: string[]; suggestion?: string; testId: string }) {
  const [custom, setCustom] = useState(() => Boolean(value) && !types.includes(value))
  return (
    <>
      <select
        value={custom ? NEW_TYPE : value}
        onChange={(e) => {
          const v = e.target.value
          setCustom(v === NEW_TYPE)
          onChange(v === NEW_TYPE ? '' : v)
        }}
        data-testid={testId}
      >
        <option value="">{suggestion ? `Suggested: ${suggestion}` : 'Choose a type'}</option>
        {types.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        <option value={NEW_TYPE}>New type…</option>
      </select>
      {custom && <input autoFocus value={value} placeholder="New type" onChange={(e) => onChange(e.target.value)} data-testid={`${testId}-new`} />}
    </>
  )
}
