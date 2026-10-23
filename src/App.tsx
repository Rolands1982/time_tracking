import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import BottomNav from './components/BottomNav'
import { ToastProvider } from './components/Toast'
import ClientsPage from './pages/ClientsPage'
import DataPage from './pages/DataPage'
import EntriesPage from './pages/EntriesPage'
import EntryFormPage from './pages/EntryFormPage'
import ReportsPage from './pages/ReportsPage'
import TimerPage from './pages/TimerPage'

export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <div className="app">
          <Routes>
            <Route path="/" element={<TimerPage />} />
            <Route path="/entries" element={<EntriesPage />} />
            <Route path="/entries/new" element={<EntryFormPage />} />
            <Route path="/entries/:id" element={<EntryFormPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/clients" element={<ClientsPage />} />
            <Route path="/data" element={<DataPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
        <BottomNav />
      </ToastProvider>
    </HashRouter>
  )
}
