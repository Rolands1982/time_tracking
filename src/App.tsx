import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import BottomNav from './components/BottomNav'
import { ToastProvider } from './components/Toast'
import ClientsPage from './pages/ClientsPage'
import DataPage from './pages/DataPage'
import EntriesPage from './pages/EntriesPage'
import EntryFormPage from './pages/EntryFormPage'
import ReportsPage from './pages/ReportsPage'
import SummaryPage from './pages/SummaryPage'
import TimerPage from './pages/TimerPage'
import SyncProvider from './sync/SyncProvider'

export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <SyncProvider>
        <div className="app">
          <Routes>
            <Route path="/" element={<TimerPage />} />
            <Route path="/entries" element={<EntriesPage />} />
            <Route path="/entries/new" element={<EntryFormPage />} />
            <Route path="/entries/:id" element={<EntryFormPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/summary" element={<SummaryPage />} />
            <Route path="/clients" element={<ClientsPage />} />
            <Route path="/data" element={<DataPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
        <BottomNav />
        </SyncProvider>
      </ToastProvider>
    </HashRouter>
  )
}
