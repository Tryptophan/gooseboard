import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initPwa } from './net/pwa'
import { initStreaming } from './net/streamSW'
import './styles/global.css'

initPwa(initStreaming())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
