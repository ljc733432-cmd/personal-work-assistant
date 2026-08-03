# AGENTS.md — 给 AI 的项目指南

> 这是"个人工作助手"项目。**任何 AI（含我自己）在改代码前，必须先读本文件。**
> 目的：保证多人/多轮 AI 协作下，项目结构、命名、技术选型一致，避免"改 A 坏 B"。

---

## 0. 一句话定位

一个**纯本地**的 Electron 桌面应用：接入国产大模型（智谱 GLM / DeepSeek）的多模型对话助手，能从对话抽任务、定时主动跟进、联网搜索、读写白名单文件。所有数据存本机。

完整需求见 `docs/需求方案设计文档.md`（PRD）。术语见 `CONTEXT.md`。

---

## 1. 技术栈（已定，不要换）

| 层 | 选型 | 备注 |
|---|---|---|
| 桌面框架 | **Electron** | 通过 electron-vite 脚手架 |
| 构建 | **electron-vite**（Vite） | React 19 + TS 5 |
| 前端 | **React + TypeScript（strict）** | |
| UI | **shadcn/ui + Tailwind** | 组件按需引入 |
| 状态 | **Zustand** | |
| 数据库 | **SQLite via better-sqlite3 + Drizzle ORM** | ⚠️ **不要用 Prisma**（见 §6 禁忌） |
| 模型调用 | **OpenAI SDK**（统一 `chat.completions`） | ⚠️ **不要用 responses API**（见 §6 禁忌） |
| Key 加密 | Electron **safeStorage** | |
| 打包 | **electron-builder** | Windows 安装包 |

---

## 2. 目录结构

```
个人工作助手/                      # 项目根（文档层）
├── AGENTS.md                      # 本文件
├── CONTEXT.md                     # 领域语言 / 术语表
├── docs/
│   ├── 需求方案设计文档.md          # PRD（需求源头）
│   ├── 技术决策记录.md              # ADR（每个关键决策为何这么定）
│   └── M1完成报告.md（...M2 等）
└── 个人工作助手-app/              # 代码层（electron-vite 项目）
    ├── electron/                  # 主进程 + 预加载
    │   ├── main.ts                # 入口
    │   ├── preload/               # contextBridge 受限暴露
    │   ├── ipc/                   # IPC handlers（按域分文件）
    │   └── services/
    │       ├── db/                # Drizzle schema + 客户端单例
    │       ├── secret.ts          # safeStorage 封装
    │       ├── providers/         # 模型适配器（deepseek/zhipu/...）
    │       ├── fileTools.ts       # 白名单 + 写入三重防护（M5）
    │       ├── searchTools.ts     # 联网搜索（Tavily/Bing，M5）
    │       └── taskExtractor.ts   # 任务抽取（M4）
    ├── src/                       # 渲染进程（React）
    │   ├── pages/                 # 对话页/任务页/设置页
    │   ├── components/
    │   └── stores/                # Zustand
    └── ...                        # electron-vite 标配
```

> 子目录分层原因：文档与代码分离，AI 读文档时不被 `node_modules` 噪音干扰。

---

## 3. 进程模型（必读）

- **主进程**：窗口/托盘/单实例/调度/文件 IO/模型调用/搜索。所有 Node 能力都在这里。
- **预加载脚本**：用 `contextBridge` 暴露**白名单 IPC**给渲染层。**绝不暴露 `require` / `ipcRenderer` 全量。**
- **渲染进程**：只跑 React，**禁止**直接调 Node API。
- 安全三件套（强制）：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。

---

## 4. 模型调用约定

- 统一用 OpenAI SDK 的 `client.chat.completions.create({ stream: true, tools })`。
- Provider 切换靠 `baseURL` + `apiKey`，不写各家官方 SDK。
- 流式：主进程接收 → `webContents.send('chat:token', chunk)` → 渲染层逐字渲染，不阻塞 UI。
- FC（Function Calling）：模型返回 `tool_calls` → 主进程执行 → 结果作为 `role:'tool'` 回灌 → 模型给最终答。
- **状态修改类 FC（标记完成/改截止日）必须二次确认**（FC 返回意图 → UI 弹确认 → 确认才执行）。
- **文件工具动态注册**（M5.1）：工具集按当前 sources（系统位置+预填+会话确认）在 `assembleTools(ctx)` 组装。sources 通过 getter 动态读取（sessionApproved 会变）。**不要写死工具集，不要把 sources 当静态数组。**
- **读取双模式**（M5.2）：**默认全盘可读**（黑名单敏感目录除外），用户在设置页配了常用目录后**锁定到该范围**。这是"开放默认、按需收窄"的设计。
- **敏感目录黑名单**（M5.2）：`isSensitive()` 永远拦截 .ssh/.gnupg/AppData/Windows/$RECYCLE.BIN/System Volume Information/node_modules/.git/本应用 userData。即便全盘模式也不读。**改黑名单清单必须更新 sensitiveDirs.ts。**
- **find_files 全盘模式**：全盘递归扫描不现实，必须提供 `searchDir`（绝对路径）。锁定模式才默认搜全部 sources。
- **write_file 走可挂起 confirm 机制**（M5）：handler 返回 `{kind:'confirm', prompt, action}`，FC 循环 await `onConfirm` → 推 `chat:confirm_request` → 前端弹窗 → 用户选 → resolve。**不要在 handler 内同步写文件，必须经 confirm。**

---

## 5. 数据模型（核心实体，见 PRD §4.2 + CONTEXT.md）

- `Task`：任务（todo/in_progress/done，priority，dueDate，remindTimes[]，source=manual/from_chat）
- `Conversation`：会话（type=normal/followup）
- `Message`：消息（role=system/user/assistant/tool，providerId 可逐条切换）
- `Provider`：模型配置（type，baseURL，model，apiKeyRef 指向 safeStorage，不存明文）
- `Settings`：KV 表（定时点、人格、工作目录白名单、截断预算、抽取开关）

---

## 6. 编码规范与禁忌

### 必做
- **TypeScript strict**，不留 `any`（实在要，加注释说明原因）。
- 命名：PascalCase 类型/组件，camelCase 函数/变量，UPPER_SNAKE 常量。
- 每个服务文件单一职责；IPC handler 按域拆文件。
- 错误：模型 API 用**指数退避重试 3 次**（429/超时/5xx），仍失败给友好提示。

### 禁忌（红线，做了会烂项目）
- ❌ **不要用 Prisma**。原因：query engine 二进制在 Electron asar 内无法执行，打包踩坑率极高，与"全靠 AI 写代码、出错率低"前提冲突。用 Drizzle。
- ❌ **不要降级 better-sqlite3 到 < 13.x**。原因：11.x 源码与 Electron 42 的新 V8 不兼容（`v8::External::Value` 签名变化），`@electron/rebuild` 编译失败。锁 ≥ 13.x。
- ❌ **不要用 OpenAI `responses` API**。原因：智谱/DeepSeek 兼容端点只支持老的 `chat.completions`。统一用 chat.completions。
- ❌ **不要在渲染进程直接调 Node API**（fs、child_process、require）。一律走 IPC。
- ❌ **不要把 API Key 明文落库**。一律走 safeStorage，库表只存引用（`apiKeyRef`）。
- ❌ **不要做云同步/服务器/账号/多用户协作**。纯本地（PRD §2.2 明确砍掉）。
- ❌ **不要执行系统命令 / shell**。安全风险。
- ❌ **不要让 write_file 绕过白名单 + 覆盖确认 + 回收站**（写入三重防护，M5 实现）。
- ❌ **不要绕过 `resolveSafePath`**。所有文件操作（list/read/find/write）的路径必须经它解析，防 `../` 逃逸 + 白名单校验。直接 `fs.readFile(用户给的路径)` 是红线。
- ❌ **不要静默建任务**。任务抽取只产草稿，必须人工点"加入任务"才入库。
- ❌ **不要静默丢历史消息**。上下文截断要 UI 提示"已省略较早的 X 条"。

---

## 7. "靠 AI 写代码"的方法论约束（本项目特有）

> 项目主理人不手动改代码，全靠 AI 生成。致命前提：AI 必须能持续一致理解项目。

1. **改代码前先读本文件 + CONTEXT.md + 相关 ADR。**
2. **小步生成**：每个功能拆成能独立跑通的最小块，生成一块、验证一块、（如启用 git）提交一块。
3. **不一次性生成大块**。M1~M7 按里程碑推进，每个里程碑内按 Step 验证。
4. **改名/改架构前**，先在 `docs/技术决策记录.md` 写明原因。

---

## 8. 当前阶段

- **进度：M1 骨架 + 技术验证**（tracer bullet）
- M1 目标：electron-vite 跑通 → 接通一家模型 → 流式 → FC 实测 → Drizzle+Electron 落库验证。
- M2~M7 见 PRD §9，**不在当前范围**。
