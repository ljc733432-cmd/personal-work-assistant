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
 */

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

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const components = useMemo(
    () => ({
      // 所有链接外开（安全：渲染层无 nodeIntegration，配合 main 的 setWindowOpenHandler）
      a: ({ node, ...props }: any) => <a {...props} target="_blank" rel="noreferrer" />,
      code: ({ inline, className, children }: any) =>
        inline ? (
          <code className={className}>{children}</code>
        ) : (
          <CodeBlock className={className}>{children}</CodeBlock>
        ),
    }),
    [],
  )

  return (
    <div className="msg-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
