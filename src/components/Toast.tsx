import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ToastContext, type ToastFn } from './toastContext'

const TOAST_MS = 3000

/**
 * Messages stack instead of replacing each other: a settlement or an ECB-rate note that lands right after
 * "Entry saved" must not hide it. Each message leaves on its own after a few seconds.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<{ id: number; text: string }[]>([])
  const next = useRef(0)
  const show = useCallback<ToastFn>((text) => {
    const id = next.current++
    setMessages((list) => [...list.slice(-2), { id, text }])
    setTimeout(() => setMessages((list) => list.filter((m) => m.id !== id)), TOAST_MS)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {messages.length > 0 && (
        <div className="toast-stack">
          {messages.map((m) => (
            <div className="toast" role="status" key={m.id}>
              {m.text}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}
