import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installDiag } from './lib/diag'
import { registerEnvDiag } from './lib/diagEnv'
import { initPwa } from './net/pwa'
import { initStreaming } from './net/streamSW'
import './styles/global.css'

installDiag()
registerEnvDiag()
initPwa(initStreaming())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
