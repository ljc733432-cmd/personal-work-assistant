import React from 'react'
import ReactDOM from 'react-dom/client'
import { IconContext } from '@phosphor-icons/react'
// v1.3 字体：Space Grotesk 标题（品牌感）+ DM Sans 正文，本地化打包离线可用
import '@fontsource-variable/space-grotesk'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/700.css'
import App from './App'
import { useThemeStore } from './stores/theme'
import './index.css'

// 防闪烁已在 index.html 内联脚本应用 .dark；这里从 settings 表校准 mode
// （localStorage 可能被清，settings 是权威源）。非阻塞，不 await。
void useThemeStore.getState().hydrateFromSettings()

// Phosphor 图标全局默认（v1.3）：regular weight + 18px，单点覆盖在品牌位用 duotone
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <IconContext.Provider value={{ weight: 'regular', size: 18 }}>
      <App />
    </IconContext.Provider>
  </React.StrictMode>,
)
