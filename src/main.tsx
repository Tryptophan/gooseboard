import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initStreaming } from './net/streamSW'
import './styles/global.css'

initStreaming()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
