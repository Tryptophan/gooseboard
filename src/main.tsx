import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installDiag } from './lib/diag'
import { registerEnvDiag } from './lib/diagEnv'
import { startReminders } from './lib/reminders'
import { initPwa } from './net/pwa'
import { initStreaming } from './net/streamSW'
import './styles/global.css'

// the installed app starts at "/": make that Home's own entry ("#/"), not one more behind it
if (!location.hash) history.replaceState(history.state, '', '#/')

installDiag()
registerEnvDiag()
initPwa(initStreaming())
startReminders()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
