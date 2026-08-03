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

### **文件工具（File Tools，M5 已实现）**
AI 通过 FC 操作白名单文件的能力。4 个工具：
- `list_files(dir)` — 列目录内容（名/大小/修改时间）
- `read_file(path)` — 读文件内容（txt/md/json/csv/代码/pdf/docx，大文件截断）
- `find_files(query, dateFrom, dateTo, ext, baseLabel)` — 按名/日期/扩展名搜索
- `write_file(path, content)` — 仅「读写」目录可用，走三重防护

**动态注册**：工具集按当前启用的 workDirs 动态组装（assembleTools）。无 workDirs → 不注册任何文件工具（模型不知道有这能力）；有只读目录 → 注册 list/read/find；有读写目录 → 额外注册 write。

### **工具确认（Tool Confirm，M5 已实现）**
write_file 覆盖已存在文件时，FC 循环**挂起**：返回 `{kind:'confirm', prompt, action}` → 主进程推 `chat:confirm_request` → 渲染层弹窗 → 用户选 → `chat:confirm_response` 回传 → resolve 挂起的 Promise → 继续。这是「可挂起 FC 循环」机制（见 AGENTS.md §4）。

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
