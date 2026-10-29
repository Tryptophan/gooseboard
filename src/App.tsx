import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { MenuHost } from './components/ContextMenu'
import { DialogHost } from './components/Dialog'
import { UpdateBanner } from './components/Install'
import { Toasts } from './components/Toasts'
import { TooltipHost } from './components/Tooltip'
import BoardPage from './pages/BoardPage'
import Home from './pages/Home'
import NewBoard from './pages/NewBoard'
import Share from './pages/Share'
import { UiProvider } from './state/ui'

// HashRouter keeps board links (/#/board/<id>) working on static hosting like GitHub Pages.
export default function App() {
  return (
    <UiProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/board/:id" element={<BoardPage />} />
          {/* the installed app's "New board" shortcut and share target */}
          <Route path="/new" element={<NewBoard />} />
          <Route path="/share" element={<Share />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
      <MenuHost />
      <DialogHost />
      <TooltipHost />
      <UpdateBanner />
      <Toasts />
    </UiProvider>
  )
}
