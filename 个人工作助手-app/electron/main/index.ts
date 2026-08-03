import { app, BrowserWindow, shell, Tray, Menu, nativeImage, Notification } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

import { registerIpcHandlers } from '../ipc'
import { logError, logInfo } from '../services/logger'
import { closeDb, getDb } from '../services/db'
import { settings } from '../services/db/schema'
import { eq } from 'drizzle-orm'
import {
  runFollowupTick,
  startFollowupScheduler,
  stopFollowupScheduler,
  startReminderPoller,
  stopReminderPoller,
} from '../services/followup/scheduler'

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
let tray: Tray | null = null
// M6：true 时表示正在真正退出（托盘"退出"触发），此时窗口 close 不再拦截。
let isQuitting = false
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

async function createWindow() {
  win = new BrowserWindow({
    title: '个人工作助手',
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(process.env.APP_ROOT, 'build/icon.ico'),
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

  // M6：关窗 = 最小化到托盘（不退出）。只有托盘"退出"才真正退出（isQuitting）。
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win?.hide()
    }
  })

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

// ---------- M6：托盘 ----------

/** 读 settings 的 followup.paused（"true"/"false"，默认 false 即启用）。 */
function isFollowupPaused(): boolean {
  try {
    const row = getDb().select().from(settings).where(eq(settings.key, 'followup.paused')).get()
    return row?.value === 'true'
  } catch {
    return false
  }
}

/** 读 settings 的 followup.cron（默认 '0 9,14 * * *' = 每天 9:00 和 14:00）。 */
function getFollowupCron(): string {
  try {
    const row = getDb().select().from(settings).where(eq(settings.key, 'followup.cron')).get()
    return row?.value || '0 9,14 * * *'
  } catch {
    return '0 9,14 * * *'
  }
}

/** 构建托盘右键菜单。paused 状态变化时重建。 */
function buildTrayMenu(): Menu {
  const paused = isFollowupPaused()
  return Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => showWindow(),
    },
    {
      label: '立即检查跟进',
      click: () => handleManualFollowup(),
    },
    { type: 'separator' },
    {
      label: paused ? '恢复定时跟进' : '暂停定时跟进',
      click: () => {
        // 翻转 paused 并重启调度
        const db = getDb()
        const now = Math.floor(Date.now() / 1000)
        db.insert(settings)
          .values({ key: 'followup.paused', value: String(!paused) })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: String(!paused), updatedAt: now },
          })
          .run()
        restartScheduler()
        tray?.setContextMenu(buildTrayMenu())
        logInfo(`[tray] 跟进已${!paused ? '暂停' : '恢复'}`)
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
}

/** 显示并聚焦窗口（从托盘恢复）。 */
function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 手动触发跟进检查（托盘"立即检查"）。 */
async function handleManualFollowup(): Promise<void> {
  try {
    const result = await runFollowupTick()
    if (result) {
      showFollowupNotification(result)
    } else {
      // 无候选或未配模型，用通知提示用户
      new Notification({
        title: '跟进检查',
        body: '当前无需跟进的任务（或未配置跟进模型）',
      }).show()
    }
  } catch (e) {
    logError('[tray] 手动跟进出错:', String(e))
  }
}

/** 弹跟进通知（cron 到点 / 手动触发都调）。点击跳转到跟进会话。 */
function showFollowupNotification(result: { conversationId: string; count: number }): void {
  const n = new Notification({
    title: '任务跟进提醒',
    body: `有 ${result.count} 个任务待跟进，点击查看`,
  })
  n.on('click', () => {
    showWindow()
    // 通知渲染层跳转到跟进会话
    win?.webContents.send('followup:open', { conversationId: result.conversationId })
  })
  n.show()
}

/** 弹提醒通知（M12.5 提醒轮询到点调）。点击显示主窗口。 */
function showReminderNotification(reminder: { id: string; content: string }): void {
  const n = new Notification({
    title: '提醒',
    body: reminder.content,
  })
  n.on('click', () => {
    showWindow()
  })
  n.show()
}

/** 启动/重启调度器（按当前 settings 的 cron + paused）。 */
async function restartScheduler(): Promise<void> {
  if (isFollowupPaused()) {
    stopFollowupScheduler()
    logInfo('[scheduler] 跟进已暂停，调度器停止')
    return
  }
  const cron = getFollowupCron()
  await startFollowupScheduler(cron, (result) => {
    if (result) showFollowupNotification(result)
  })
}

function createTray(): void {
  // 托盘图标：build/icon.ico（electron-vite 脚手架默认位置）。
  // 注意不是 public/favicon.ico——那个文件项目里不存在。
  const iconPath = path.join(process.env.APP_ROOT, 'build/icon.ico')
  logInfo('[tray] 图标路径:', iconPath, '存在:', fs.existsSync(iconPath) ? '是' : '否')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    // 兜底：build/icon.png
    const pngPath = path.join(process.env.APP_ROOT, 'build/icon.png')
    logInfo('[tray] ico 失败，尝试 png:', pngPath, '存在:', fs.existsSync(pngPath) ? '是' : '否')
    image = nativeImage.createFromPath(pngPath)
  }
  if (image.isEmpty()) {
    logInfo('[tray] 图标全部加载失败，用空 image（菜单仍可用，只是无图标）')
    image = nativeImage.createEmpty()
  }
  tray = new Tray(image)
  tray.setToolTip('个人工作助手')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => showWindow())
  logInfo('[tray] 托盘已创建')
}

// ---------- app 生命周期 ----------

app.whenReady().then(async () => {
  registerIpcHandlers()
  createWindow()
  createTray()
  await restartScheduler()
  // M12.5：启动提醒轮询（每分钟扫到期提醒，弹通知）
  startReminderPoller((reminder) => showReminderNotification(reminder))
})

// M6：关窗不再退出（缩托盘），所以这里不做 app.quit()。
app.on('window-all-closed', () => {
  // macOS 沿用平台惯例（不退出）；其他平台也保留托盘常驻（M6 改动）
})

app.on('second-instance', () => {
  showWindow()
})

app.on('activate', () => {
  // macOS 点 dock 图标
  showWindow()
})

// M6：退出前停调度器
app.on('before-quit', () => {
  isQuitting = true
  stopFollowupScheduler()
  stopReminderPoller()
})

// M6：所有窗口已关、app 即将退，关闭 DB 连接（之前一直没调，WAL 不落盘）
app.on('will-quit', () => {
  closeDb()
})
