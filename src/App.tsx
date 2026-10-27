import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { MenuHost } from './components/ContextMenu'
import { DialogHost } from './components/Dialog'
import BoardPage from './pages/BoardPage'
import Home from './pages/Home'
import { UiProvider } from './state/ui'

// HashRouter keeps board links (/#/board/<id>) working on static hosting like GitHub Pages.
export default function App() {
  return (
    <UiProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/board/:id" element={<BoardPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
      <MenuHost />
      <DialogHost />
    </UiProvider>
  )
}
