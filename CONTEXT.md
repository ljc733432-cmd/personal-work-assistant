# CONTEXT.md — 领域语言 / 术语表

> 固化本项目的核心术语，避免 AI 每次重新发明命名。改代码时用这里的**规范词**，不要自造同义词。
> 格式：**术语**（英文/别名）— 定义 + 技术落点。

---

## A. 模型与对话域

### **Provider（模型提供方 / 模型配置）**
一家可接入的大模型服务。一条 `Provider` 记录 = `{id, name, type, baseURL, model, apiKeyRef, enabled}`。
- `type` 取值：`deepseek` / `zhipu` / `custom`（任意 OpenAI 兼容接口）。
- `apiKeyRef` 不存明文 Key，是指向 safeStorage 的引用。
- **不要叫**："模型""接口""账号"——Provider 指的是「模型配置」这一实体。

### **Provider 抽象层（Provider Adapter / 适配器）**
主进程里 `electron/services/providers/` 下，每家模型一份适配器，对外暴露统一的 `chat(messages, tools, onToken)` 流式方法。底层都走 OpenAI SDK，靠 `baseURL`+`apiKey` 切换。

### **Conversation（会话）**
一段连续对话。`{id, title, type, scenarioId?, defaultProviderId?, pinned, createdAt, updatedAt}`。
- `type=normal` 普通会话；`type=followup` **跟进会话**（见下）。
- `title` 自动用首条消息生成，可改。

### **Message（消息）**
会话里的一条消息。`{role, content, providerId?, toolCalls?, attachments?}`。
- `role`：`system` / `user` / `assistant` / `tool`（FC 结果）。
- `providerId` 逐条记录用哪个模型，支持**会话内切模型**。

### **会话内切模型（In-conversation model switch）**
同一会话不同轮可用不同 Provider。每条 Message 记 `providerId`，切换后后续轮用新模型。

### **上下文预算 / 上下文截断（Context Budget / Truncation）**
按 **token 数**（非消息条数）管理单会话历史。每模型设上限（默认 32k）。
- 截断顺序：永远保留 `系统提示` + `最近 N 轮`，从最旧 user 消息丢起。
- 截断时 UI 提示"已省略较早的 X 条消息"，不静默丢。

### **流式 IPC（Streaming IPC）**
主进程流式接收模型输出 → `webContents.send('chat:token', chunk)` → 渲染层逐字渲染，不阻塞 UI。

---

## B. 任务域

### **Task（任务）**
中性通用待办，不预设职业。`{title, description?, status, priority, dueDate?, remindTimes[], source, sourceConversationId?, followupLog}`。
- `status`：`todo` / `in_progress` / `done`。
- `priority`：`low` / `medium` / `high`。
- `source`：`manual`（手动建）/ `from_chat`（AI 抽取）。

### **任务抽取草稿（Extraction Draft）**
AI 从对话中抽出的任务**草稿**。**不直接入库**，必须用户点"加入任务"才落库。
- 入库时自动填 `source=from_chat` + `sourceConversationId`（可溯源）。
- 触发方式：默认**手动**（点 ✨ 按钮）；可在设置开"自动抽取"（防抖：停输入 5s 或一轮结束后跑一次）。
- 用**最便宜的模型**跑，省成本。

### **跟进会话（Followup Conversation）**
`type=followup` 的特殊会话。AI 主动发起，问任务进展；用户回复后 AI 通过 FC 改任务状态/追加 followupLog。

### **跟进日志（followupLog）**
Task 字段，追加式文本，记录每次 AI 跟进时用户的回复摘要。

---

## C. 主动跟进域

### **常驻 / 托盘（Tray）**
关主窗口 → 最小化到系统托盘（不退出）。托盘菜单：显示窗口 / 立即检查 / 暂停跟进 / 退出。单实例锁。

### **定时调度（Scheduler）**
跑在**主进程**（不依赖前端页面）。默认时间点 09:00、14:00（可改）。
- **无候选任务 → 不调用模型、不发通知**（省 API）。
- **未配置任何模型 Key → 不调用**，托盘显示"⚠ 未配置模型，跟进已暂停"。
- 用用户设定的**跟进模型**（默认与默认 Provider 同；可单独指定便宜模型）。

### **到点流程（Tick Flow）**
查"今天到期/逾期/高优先级未完成" → 有候选才调跟进模型生成消息 → 弹桌面通知 → 点击进跟进会话。

---

## D. 工具能力域

### **Function Calling / FC（函数调用）**
模型通过 OpenAI `tools` 参数发起的工具调用。本项目用于：任务抽取、改任务状态、文件读写、联网搜索。
- **状态修改类 FC 必须二次确认**：FC 返回意图 → UI 弹"确认完成「XX」？"→ 确认才执行。防误改。

### **联网搜索（Web Search）**
FC 工具 `web_search(query)`。v1 接 **Tavily + Bing 两家**，设置里可切换（M5 实现，M1 只预留适配层）。
- Key 同模型 Key 一样 safeStorage 加密。
- 结果由模型摘编进回答，并标注来源链接。

### **工作目录白名单（Working Directory Whitelist）**
设置里配 1~3 个目录。`read_file` / `write_file` FC 工具**主进程硬校验白名单**，越界拒绝 + 日志。

### **写入三重防护（Write Triple Guard）**
`write_file` 的强制安全链（M5 实现）：
1. **路径校验**：解析真实路径防 `../` 逃逸，必须在白名单内。
2. **覆盖确认**：目标已存在 → UI 弹"AI 要覆盖 X，确认？"，拒绝则不写。
3. **回收站**：覆盖前原文件移到 `userData/fileTrash/{timestamp}/`，保留可恢复；定期清理（默认 7 天）。

### **回收站（File Trash）**
`userData/fileTrash/{timestamp}/`，存被覆盖的原文件。

### **文件工具（File Tools，M5.1 已实现）**
AI 通过 FC 操作文件的能力。**三来源读取 + 写入三重防护**。

**三种读取来源（sources）**：
1. **系统标准位置**（开箱即用，只读）：文档/桌面/下载，`app.getPath()` 获取
2. **预填常用目录**（设置页「常用目录」区，可选）：用户填的额外目录，可只读/读写
3. **会话已确认目录**（对话临时指定，只读）：用户对话里说的新目录，首次确认后本次会话有效，重启清空

**工具**：
- `list_accessible_dirs()` — 列当前可访问的目录（让模型知道范围，优先调它）
- `list_files(dir)` / `read_file(path)` / `find_files(query,dateFrom,dateTo,ext,baseLabel)`
- `write_file(path, content)` — 仅 readwrite 目录可用，走三重防护

**首次确认机制**：读操作遇到 sources 外的新目录 → 返回 `{needsConfirm}` → FC 循环挂起弹窗 → 用户同意 → 加入 sessionApprovedDirs → 重试。系统位置/预填目录不弹（已信任）。

**动态组装**：`assembleTools(ctx)` 按当前 sources 组装。sources 通过 getter 动态读取（sessionApproved 会变）。

### **AccessibleDir（可访问目录）**
统一目录描述：`{label, path, source('system'|'workdir'|'session'), mode('read'|'readwrite')}`。系统位置和会话目录恒只读，预填目录按用户设。

### **会话授权目录（sessionApprovedDirs）**
主进程内存里的 `AccessibleDir[]`，存本次运行期间用户对话里临时授权的目录。重启清空（避免误授权累积）。

### **工具确认（Tool Confirm，M5 已实现）**
write_file 覆盖已存在文件时，FC 循环**挂起**：返回 `{kind:'confirm', prompt, action}` → 主进程推 `chat:confirm_request` → 渲染层弹窗 → 用户选 → `chat:confirm_response` 回传 → resolve 挂起的 Promise → 继续。这是「可挂起 FC 循环」机制（见 AGENTS.md §4）。

---

## D2. v1.2 工具扩展域（M12.5~M12.9）

### **双轨制（Dual Track，v1.2）**
工具的两种形态，服从用途而非强求统一（PRD §13.1）：
- **A 轨（FC 工具）**：注册进 `assembleTools`，AI 在对话中调用（如 `create_note` `set_reminder` `convert_document`）。
- **B 轨（手动页面）**：独立 React 页面 + IPC，用户主动用（如笔记编辑器、番茄钟、转换器 UI）。
- **关键约束**：A 轨与 B 轨**共享同一存储层**（笔记库目录 / reminders 表），保证不是两套孤立系统。
- **不要叫**："插件"/"扩展"——双轨制特指 FC + 手动页面的组合形态。

### **Reminder（提醒）**
到点告诉一件事的信号（PRD §13.2 工具 2）。`{id, time, content, done, source, createdAt}`。
- **与 Task 的区别**：Task 是「有截止日的工作」（有完成度）；Reminder 是「响一下就完」的信号，不进任务列表。
- **source**：`manual`（工具页手建）/ `from_chat`（AI 从对话抽取）。
- **无副作用**：PRD §13.2 明确提醒可随时删，AI 抽取**无需人工确认**直接入库（区别于任务抽取草稿）。
- **调度**：复用 node-cron 同源的 setInterval 轮询（每分钟扫到期），非 cron 定点（提醒时间任意到分）。

### **PomodoroSession（番茄钟历史）**
专注计时记录（PRD §13.2 工具 2）。`{startedAt, durationMin, taskId?, completed}`。
- **纯 B 轨**：计时器做成 FC 无意义（AI 无法「开始一个 25 分钟」）。
- **常驻侧栏小部件**：PRD §12.3 要求常驻，本项目放侧栏底部（单一挂载点比改顶栏简单）。
- **默认 25 分钟**：PRD §13.2 三档可配，v1.2 先做 25。

### **Notes / 笔记（v1.2 工具 1）**
纯本地 Markdown 笔记库（PRD §13.2）。`Note = {id, title, tags, content, createdAt, updatedAt, fileName}`。
- **存储**：纯 `.md` 文件 + frontmatter，**不入库**（v2 才加索引层）。frontmatter 存 id/title/tags/时间戳。
- **笔记库目录（notes.rootDir）**：settings KV 配置，默认 `userData/notes/`。**自动加入文件工具白名单**（readwrite），AI 能直接读写，无需用户额外配。
- **搜索**：v1.2 文件遍历 + 字符串匹配（限制 <500 条），v2 加索引。
- **双轨**：A 轨 `create_note/search_notes/read_note/update_note`（update 走二次确认，覆盖原内容）；B 轨笔记页 CRUD。
- **不要叫**："备忘录"/"文档"——Notes 特指本地 .md 笔记库。

### **Document Converter（文档转换，v1.2 工具 3）**
格式转换（PRD §13.2）。`{inputPath, targetFormat, outputPath?}`。
- **支持矩阵**：md↔txt、md→html/docx/pdf、docx→md/txt/html。
- **PDF 生成**：pdfkit + 系统字体 `simhei.ttf`（TV-4 验证；pdfkit 不支持 .ttc）。
- **安全**：输入输出路径经 `resolveSafePath`（白名单/笔记库）。
- **无破坏性**：原文件不动，输出到同目录换扩展名。不走二次确认。

### **语义色 token（Semantic Color Token，v1.2 UI）**
取代散落的 Tailwind 原生色类（`bg-blue-100` 等）。见 PRD §12.2.1 + 验收 V-O。
- `--success`（完成/通过）/ `--warning`（草稿/警示）/ `--danger`（错误/危险）/ `--info`（信息提示，同 accent）。
- 所有业务组件**禁止**用 `bg-slate-/bg-blue-/bg-green-` 等原生类，必须走 token。
- grep 治理：验收 V-O 要求全项目 0 处原生色类残留。

### **签名消息块（Signature Message Block，v1.2 UI）**
PRD §12.2.4 签名元素：无圆角矩形 + 左侧 2px role 色条。
- user=accent 蓝 / assistant=muted-foreground 灰 / tool=success 绿。
- 区别于所有圆角气泡的 AI 应用，像精装卷宗条目。

---

## D3. v1.3 UI 重造域（M13.1~M13.6）

### **Soft UI（柔和阴影系统，v1.3）**
ui-ux-pro-max skill 推荐的层次质感风格（ADR-018）。在 v1.2 冷调克制基础上叠加：
- **多级 surface**：surface-1（页面底）/ surface-2（卡片层）/ surface-3（浮层），治「配色太素」。
- **柔和阴影**：shadow-xs/sm/md/lg 多层漫射+近距投影，卡片有浮起感（非生硬投影）。
- **适度圆角**：radius 0.5rem（v1.2 的 0.25rem 偏硬，Soft UI 需配柔和阴影）。
- **不动电光蓝主色**，只加层次。

### **概览页（Overview Page，v1.3 信息架构）**
新增首页（M13.4），治「信息架构单一」。聚合今日任务/提醒/专注/笔记数据：
- 品牌头部（问候 + 日期时间）+ 概览卡片网格 + 快捷入口 + 最近活动。
- 默认首页从「对话」改为「概览」，导航 6 项。
- 数据从现有 store 取，零新增 IPC。

### **图标映射表（Icon Mapping，v1.3）**
`src/components/ui/icons.ts`：lucide 名 → Phosphor 组件的语义化别名出口。
- 业务文件统一从 `@/components/ui/icons` import，图标名保持（v1.2 别名兼容）。
- 品牌位单点传 `weight="duotone"`（导航激活态/空状态/概览卡片/工具入口）。
- **不要**直接从 `@phosphor-icons/react` import（绕过映射表失去统一维护点）。

### **EmptyState（统一空状态，v1.3）**
`src/components/ui/EmptyState.tsx`：Phosphor 64px duotone 大图标 + 标题 + 引导文案。
- 全应用空状态走它，品牌一致。**不要**手写 div + 小图标做空状态。

---

## D4. v1.4 数据看板域（M14）

### **Dashboard（数据看板，v1.4）**
生产力分析页（PRD §16.5，ADR-020）。**与概览页的区别**：
- **概览页（Overview Page）= 今日快照**：默认首页，今日数据 + 快捷入口，信息密度低。
- **数据看板（Dashboard）= 历史趋势**：可切换 7天/30天/全部 的生产力分析（专注趋势、任务新建、状态分布、专注时段），多图 + 时间范围，信息密度高。
- 两者互补不重复，分别独立 Tab（侧栏：概览 → 看板，数据展示组）。
- **不要叫**："首页/统计页/报表"——Dashboard 特指历史趋势分析页。

### **DashboardRange（时间范围，v1.4）**
看板的时间筛选：`'7d' | '30d' | 'all'`。切换时所有图表 + StatCard 联动刷新。
- pomodoro/tasks/notes 按 `startedAt`/`createdAt` 前端过滤（复用现有 list，全量拉取）。
- all 模式图表不补零，只显示有数据的天。

### **ActivityPoint（对话活跃度，v1.4）**
messages 表按天聚合：`{ date: 'YYYY-MM-DD', count: number }`。
- 走专属聚合 IPC `dashboard:activity`（三处同步），**只回 date+count，不传 content 大字段**（messages 表可能大，全量拉浪费）。
- 主进程 `GROUP BY date(created_at,'unixepoch')` 聚合。

### **图表模式（Chart Mode，v1.4）**
看板图表分两组，用 SegmentedSwitcher 切换（省纵向空间，每屏只看 2 图）：
- **趋势**：专注折线（每日专注分钟）+ 任务新建柱状（每日新建数）。
- **分布**：任务状态饼图（todo/in_progress/done 占比）+ 专注时段柱状（深夜/早晨/下午/晚间）。

### **SegmentedSwitcher（分段切换器，v1.4）**
通用分段选择组件（DashboardPage 内）：选中态用 `bg-accent/10 + text-accent`（v1.3 红线规范）。复用给时间范围和图表模式切换，避免重复代码。

---

## E. 基础设施域

### **safeStorage**
Electron 内置的操作系统级加密存储（Win 上走 DPAPI）。**所有 API Key 一律走它**，库里只存 `apiKeyRef` 引用，不存明文。

### **userData**
Electron 给应用的用户数据目录（Win 上一般在 `%APPDATA%/<appName>`）。`app.db`、日志、回收站都放这。

### **app.db**
SQLite 单文件库，存所有业务数据。路径：`app.getPath('userData')/app.db`。

### **离线降级（Offline Degradation）**
断网时：任务 CRUD、查看历史对话、托盘常驻**仍可用**；模型对话/搜索/跟进调用**降级**（按钮灰掉 + 提示）。

### **指数退避重试（Exponential Backoff Retry）**
模型 API 遇 429/超时/5xx → 重试最多 3 次，间隔指数增长。仍失败给友好提示。

---

## F. 阶段与验收术语

### **里程碑（Milestone, M1~M7）**
PRD §9 定义的开发阶段。当前 **M1 骨架 + 技术验证**。

### **技术验证（Technical Verification, TV）**
M1 必做的关键路径实测：
- **TV-1**：智谱 FC 是否可用 → **已确认支持**（GLM 全系列在兼容端点支持 tools）。
- **TV-2**：智谱 vs DeepSeek 谁更省更稳用于抽取/跟进。
- **TV-3**：搜索 API 选 Tavily 还是 Bing → 已定**两家都接**，M5 实现。

### **Tracer Bullet**
M1 的性质——打穿最险链路（脚手架→模型→流式→FC→落库），证明后续里程碑走得通，不追求功能完整。

### **P0 / P1**
PRD §7 验收优先级。P0 必做 = v1 完成；P1 可选。

---

## G. 反词表（不要用这些词替代规范词）

| ❌ 不要说 | ✅ 用这个 |
|---|---|
| 模型 / 接口 / 账号 | **Provider** |
| 工具调用 | **Function Calling / FC** |
| 待办 / 事项 / to-do | **Task** |
| 提醒 / 推送 | **跟进 / 桌面通知**（区分：跟进=AI 主动扫任务+对话；通知=系统弹窗） |
| 文件夹 / 路径 | **工作目录白名单**（特指设置里配的目录） |
| 删除文件 | **进回收站**（不直接删，进 fileTrash 可恢复） |
| 提醒 / 推送（指到点响一下的信号） | **Reminder**（区别于跟进=AI 主动扫任务+对话） |
| 备忘录 / 文档 | **笔记（Notes）**（特指本地 .md 笔记库） |
| 插件 / 扩展 | **双轨制**（FC 工具 + 手动页面的组合形态） |
| 首页 / 主页 / dashboard | **概览页（Overview Page）**（v1.3 新增首页，聚合数据） |
| 空状态 / 占位 | **EmptyState**（统一组件，Phosphor duotone 大图标） |
| 首页 / 统计页 / 报表 | **Dashboard**（v1.4 数据看板，历史趋势分析，区别于概览页今日快照） |
