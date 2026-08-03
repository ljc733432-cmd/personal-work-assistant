import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import App from './App'
import { useThemeStore } from './stores/theme'
import './index.css'

// 防闪烁已在 index.html 内联脚本应用 .dark；这里从 settings 表校准 mode
// （localStorage 可能被清，settings 是权威源）。非阻塞，不 await。
void useThemeStore.getState().hydrateFromSettings()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
