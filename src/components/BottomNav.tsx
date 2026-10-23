import { NavLink } from 'react-router-dom'

const items = [
  { to: '/', label: 'Timer', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.1.8-1.3-4.5-2.7z' },
  { to: '/entries', label: 'Entries', icon: 'M3 5h18v2H3zm0 6h18v2H3zm0 6h12v2H3z' },
  { to: '/reports', label: 'Reports', icon: 'M4 20h16v2H4zM6 10h3v8H6zm5-6h3v14h-3zm5 4h3v10h-3z' },
  { to: '/clients', label: 'Clients', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-8 1.7-8 4v2h16v-2c0-2.3-4.7-4-8-4z' },
  { to: '/data', label: 'Data', icon: 'M12 3C7 3 4 4.3 4 6v12c0 1.7 3 3 8 3s8-1.3 8-3V6c0-1.7-3-3-8-3zm0 2c3.9 0 6 1 6 1s-2.1 1-6 1-6-1-6-1 2.1-1 6-1zm6 13c0 .2-2.1 1-6 1s-6-.8-6-1v-2.3c1.5.8 3.7 1.3 6 1.3s4.5-.5 6-1.3V18zm0-4.5c0 .2-2.1 1-6 1s-6-.8-6-1V8.8C7.5 9.5 9.7 10 12 10s4.5-.5 6-1.2v4.7z' },
]

export default function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Main">
      {items.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={it.icon} />
          </svg>
          {it.label}
        </NavLink>
      ))}
    </nav>
  )
}
