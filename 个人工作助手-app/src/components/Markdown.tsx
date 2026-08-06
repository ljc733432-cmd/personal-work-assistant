import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'

/**
 * 消息内容 Markdown 渲染。
 * - GitHub 风格（表格、删除线、任务列表）
 * - 代码块用 highlight.js 高亮
 * - 流式中途也安全（不完整代码块不会崩）
 *
 * 排版样式见 index.css 的 .msg-markdown。
 *
 * v1.15 笔记大纲折叠（§15.2③）：heading 加 id（slugify）作为大纲跳转锚点。
 * 对聊天侧无副作用——id 不影响渲染，只在大纲跳转时用。
 */

/** 把标题文本转成 url-safe 的 slug（保留中文，标点/空白转 -）。
 *  例如「Q4 产品 规划！」→「q4-产品-规划」。 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '-') // 连续空白/标点（含中文标点）合并成一个 -
    .replace(/^-+|-+$/g, '') // 去首尾 -
}

/** 取 heading 子节点的纯文本（react-markdown 的 children 可能是数组/元素/字符串）。 */
function nodeText(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(nodeText).join('')
  if (children && typeof children === 'object' && 'props' in (children as any)) {
    return nodeText((children as any).props?.children)
  }
  return ''
}

/** v1.17 笔记贴图：把相对路径图片 src 解析成 file:// 绝对路径。
 *  - 绝对 URL（http/https/data/file 开头）原样返回。
 *  - 有 imgBaseUrl 时：拼接 baseUrl + src，转成 file:// 协议（Electron 渲染层需 file:// 才能加载本地图）。
 *  - 无 imgBaseUrl：原样返回（聊天侧行为不变）。 */
function resolveImgSrc(src: string | undefined, imgBaseUrl?: string): string | undefined {
  if (!src) return src
  // 绝对 URL 原样
  if (/^(https?:|data:|file:)/i.test(src)) return src
  if (!imgBaseUrl) return src
  // 相对路径：拼成绝对路径后转 file:// （Windows 路径 E:\ → file:///E:/）
  const full = imgBaseUrl.replace(/[\\/]+$/, '') + '/' + src.replace(/^[\\/]+/, '')
  // 统一斜杠 + 确保三个斜杠（file:/// + 盘符）
  const normalized = full.replace(/\\/g, '/')
  return 'file:///' + normalized.replace(/^\/+/, '')
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children ?? '')
  // react-markdown 末尾常带 \n，去掉
  const code = text.replace(/\n$/, '')
  const lang = /language-(\w+)/.exec(className || '')?.[1]

  // 有语言且能识别 → 高亮；否则原样
  let highlighted: string
  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(code, { language: lang }).value
  } else {
    // 自动检测（流式时不一定准，但安全）
    try {
      highlighted = hljs.highlightAuto(code).value
    } catch {
      highlighted = code
    }
  }

  return (
    <pre>
      <code className={className} dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  )
}

export const Markdown = memo(function Markdown({
  content,
  imgBaseUrl,
}: {
  content: string
  /** v1.17 笔记贴图：图片相对路径（如 images/x.png）的前缀解析基准。
   *  设了之后，![](images/x.png) 会解析成 file:// 笔记库绝对路径，预览态能正确渲染。
   *  绝对 URL（http/data/file）原样不动。聊天侧不传此 prop，行为不变。 */
  imgBaseUrl?: string
}) {
  // v1.15：heading id 计数器。每次 content 变化重置（用 useMemo 重建），
  // 保证同篇笔记内重复标题能生成唯一 id（「会议记录」→「会议记录」「会议记录-1」）。
  const idCounter = useMemo(() => new Map<string, number>(), [content])

  const components = useMemo(
    () => {
      // 给 heading 加 id 锚点（笔记大纲跳转用）
      const headingWithId = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
        ({ node, children, ...props }: any) => {
          const base = slugify(nodeText(children)) || `heading`
          const count = idCounter.get(base) ?? 0
          idCounter.set(base, count + 1)
          const id = count === 0 ? base : `${base}-${count}`
          return (
            <Tag id={id} {...props}>
              {children}
            </Tag>
          )
        }
      return {
        // 段落用 div 而非 p：避免 <p> 嵌套 <pre>（代码块）触发 HTML 非法嵌套报错
        p: ({ node, ...props }: any) => <div {...props} />,
        // 所有链接外开（安全：渲染层无 nodeIntegration，配合 main 的 setWindowOpenHandler）
        a: ({ node, ...props }: any) => <a {...props} target="_blank" rel="noreferrer" />,
        code: ({ inline, className, children }: any) =>
          inline ? (
            <code className={className}>{children}</code>
          ) : (
            <CodeBlock className={className}>{children}</CodeBlock>
          ),
        // v1.17 笔记贴图：相对路径图片用 imgBaseUrl 解析成 file:// 绝对路径。
        // v1.17.1：图片加边框/阴影/间距，和正文明确区分（用户反馈文字截图和正文融为一体）。
        img: ({ src, alt }: any) => {
          const resolvedSrc = resolveImgSrc(src, imgBaseUrl)
          return (
            <img
              src={resolvedSrc}
              alt={alt}
              className="my-3 rounded-md border border-border bg-surface-3 p-1 shadow-sm max-w-full"
            />
          )
        },
        h1: headingWithId('h1'),
        h2: headingWithId('h2'),
        h3: headingWithId('h3'),
        h4: headingWithId('h4'),
        h5: headingWithId('h5'),
        h6: headingWithId('h6'),
      }
    },
    [idCounter, imgBaseUrl],
  )

  return (
    <div className="msg-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
