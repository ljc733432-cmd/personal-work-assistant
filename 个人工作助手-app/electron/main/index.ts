import { app, BrowserWindow, shell } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

import { registerIpcHandlers } from '../ipc'
import { logError } from '../services/logger'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 全局错误兜底：未捕获的异常 / 未处理的 Promise rejection。
// 默认情况下 Electron 会弹原生报错窗口（用户看到的就是这个）。
// 这里改为写日志 + 控制台，避免弹窗打断用户；真正要排障看 userData/app.log。
// （根因治理仍应在具体调用点 try/catch；这里是最后防线。）
process.on('uncaughtException', (err) => {
  logError('[main] uncaughtException:', err?.stack ?? String(err))
})
process.on('unhandledRejection', (reason) => {
  logError('[main] unhandledRejection:', reason instanceof Error ? reason.stack : String(reason))
})

// 构建产物结构：
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > 主进程
// │ └─┬ preload
// │   └── index.mjs   > 预加载
// └─┬ dist
//   └── index.html    > 渲染进程
process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// Win7 关硬件加速；Win10+ 设 AppUserModelID 让通知显示应用名
if (process.platform === 'win32' && os.release().startsWith('6.1')) {
  app.disableHardwareAcceleration()
}
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

// 单实例锁
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

async function createWindow() {
  win = new BrowserWindow({
    title: '个人工作助手',
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      // 安全三件套（AGENTS.md §3 强制）：
      contextIsolation: true, // 隔离预加载与页面上下文
      nodeIntegration: false, // 渲染层禁用 Node
      sandbox: true, // 沙箱化预加载
    },
  })

  win.on('ready-to-show', () => win?.show())

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // 外链用系统浏览器打开，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', () => {
  win = null
  // M1：关窗即退出。M6 会改成缩托盘常驻。
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})
