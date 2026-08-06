/**
 * OCR 服务（v1.16 PRD §15.4④）。
 *
 * 基于 tesseract.js 在主进程跑 OCR（worker_threads），不依赖模型多模态能力——
 * 任何 Provider（含纯文本模型如 DeepSeek）都能用，因为图片已被本地 OCR 转成文字。
 *
 * 语言数据本地化（不走 CDN）：
 *  - 国内访问 tessdata.projectnaptha.com CDN 极慢（eng 10MB 要 6 分钟，chi_sim 40MB 要 20+ 分钟），
 *    用户体验不可接受。改为打包内置 traineddata.gz（build/tessdata → 打包后 resources/tessdata）。
 *  - langPath 指向本地目录，tesseract 直接读 .traineddata.gz（自动解压）。
 *
 * worker 单例懒加载：首次 OCR 调用才创建 worker（加载 core/wasm + 语言数据约 1-3 秒），
 * 之后复用。app quit 时 terminate 释放内存（worker 常驻约 50-100MB）。
 *
 * 打包关键（AGENTS.md 红线）：tesseract.js + tesseract.js-core 的 worker/wasm 文件
 * 在 asar 内无法加载，必须在 electron-builder.json 配 asarUnpack 解包。
 */
import { app } from 'electron'
import { createWorker, type Worker } from 'tesseract.js'
import path from 'node:path'
import fs from 'node:fs'
import { logInfo, logError } from './logger'

let workerPromise: Promise<Worker> | null = null

/**
 * 解析语言数据目录（.traineddata.gz 所在）。
 * - dev：项目根/build/tessdata（__dirname 是 dist-electron/main，往上两级到项目根）
 * - 打包后：process.resourcesPath/tessdata（electron-builder 的 extraResources 复制）
 */
function resolveLangDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'tessdata')
  }
  // dev：__dirname 在编译后是 dist-electron/main（notBundle 模式保留源码结构时是 electron/services）
  // 统一用 app.getAppPath()（dev 下指向项目根）+ build/tessdata
  return path.join(app.getAppPath(), 'build', 'tessdata')
}

/**
 * 懒加载 OCR worker（单例）。
 * 首次调用时创建：加载 tesseract-core wasm + chi_sim/eng 语言数据。
 * 语言数据缺失时抛清晰错误（提示重新安装/打包配置问题）。
 */
async function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise

  workerPromise = (async () => {
    const langDir = resolveLangDir()
    logInfo('[ocr] 初始化 worker，语言数据目录:', langDir)

    // 校验语言数据存在（打包/开发配置错误的早期发现）
    if (!fs.existsSync(langDir)) {
      throw new Error(`OCR 语言数据目录不存在：${langDir}。请检查打包配置或重新安装。`)
    }
    const hasEng = fs.existsSync(path.join(langDir, 'eng.traineddata.gz'))
    const hasChi = fs.existsSync(path.join(langDir, 'chi_sim.traineddata.gz'))
    if (!hasEng || !hasChi) {
      throw new Error(
        `OCR 语言数据不完整（eng=${hasEng}, chi_sim=${hasChi}）于 ${langDir}。` +
          '需要 eng.traineddata.gz 和 chi_sim.traineddata.gz。',
      )
    }

    const worker = await createWorker(['chi_sim', 'eng'], 1, {
      // langPath 指向本地目录，tesseract 直接读 .traineddata.gz（自动解压）
      langPath: langDir,
      cachePath: langDir, // 缓存到同目录（避免再下载）
      // workerPath/corePath 让 tesseract 自动从 node_modules 解析（Node 模式默认行为）
      logger: (m) => {
        if (m.status) {
          logInfo(`[ocr] ${m.status}${m.progress ? ` ${Math.round(m.progress * 100)}%` : ''}`)
        }
      },
      errorHandler: (err) => logError('[ocr] worker error:', err),
    })
    logInfo('[ocr] worker 就绪')
    return worker
  })()

  // 创建失败则清空 promise，允许下次重试
  workerPromise.catch(() => {
    workerPromise = null
  })

  return workerPromise
}

/**
 * 识别图片，返回文本。
 * @param absPath 图片绝对路径（必须已经过 resolveSafePath 校验）
 * @param timeoutMs 超时毫秒（默认 60s，OCR 大图/复杂版面可能慢）
 */
export async function recognizeImage(absPath: string, timeoutMs = 60_000): Promise<string> {
  const worker = await getWorker()
  // 超时保护：OCR 可能很慢（大图/复杂版面），避免 FC 循环卡死
  const result = await Promise.race([
    worker.recognize(absPath),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`OCR 超时（${timeoutMs / 1000}s）`)), timeoutMs),
    ),
  ])
  const text = (result.data.text ?? '').trim()
  logInfo(`[ocr] 识别完成，置信度 ${result.data.confidence ?? '?'}, 文本长度 ${text.length}`)
  return text
}

/**
 * app quit 时清理 worker（释放内存）。
 * 在 main 进程 before-quit 钩子里调用。
 */
export async function closeOcrWorker(): Promise<void> {
  if (workerPromise) {
    try {
      const worker = await workerPromise
      await worker.terminate()
      logInfo('[ocr] worker 已终止')
    } catch (e) {
      logError('[ocr] 终止 worker 失败:', e)
    }
    workerPromise = null
  }
}
