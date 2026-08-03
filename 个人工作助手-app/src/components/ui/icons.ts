/**
 * 图标统一出口（v1.3）。
 *
 * 从 lucide-react 迁移到 @phosphor-icons/react（品牌质感更强，支持 duotone/fill）。
 * 本文件做两件事：
 *  1. re-export Phosphor 图标，用语义化别名（与原 lucide 名对齐，业务代码无需改名）
 *  2. 提供品牌图标（duotone weight）给品牌位用（导航激活态/空状态/首页看板）
 *
 * 迁移规则：业务文件把 `from 'lucide-react'` 改成 `from '@/components/ui/icons'`，
 * 用到的图标名保持不变（这里是别名）。需要 duotone 时单点传 weight="duotone"。
 */
export {
  // 导航/操作类（功能位，regular weight，由 IconContext 全局默认）
  ChatCircleIcon as MessageSquare, // 对话
  ChecksIcon as CheckSquare, // 任务（复数勾选，区别于单 Check）
  NotePencilIcon as StickyNote, // 笔记
  WrenchIcon as Wrench, // 工具
  GearIcon as Settings, // 设置
  SunIcon as Sun, // 主题
  MoonIcon as Moon, // 主题
  MonitorIcon as Monitor, // 跟随系统
  PlusIcon as Plus, // 添加
  XIcon as X, // 关闭/删除
  MagnifyingGlassIcon as Search, // 搜索
  PencilSimpleIcon as Pencil, // 编辑
  EyeIcon as Eye, // 预览
  ArrowLeftIcon as ArrowLeft, // 返回
  ArrowRightIcon as ArrowRight, // 流程箭头
  TrashIcon as Trash2, // 删除（lucide 叫 Trash2，Phosphor 叫 Trash）
  FolderOpenIcon as FolderOpen, // 目录
  PlayIcon as Play, // 播放/开始
  PauseIcon as Pause, // 暂停
  ArrowCounterClockwiseIcon as RotateCcw, // 复位
  TimerIcon as Timer, // 番茄钟
  BellRingingIcon as Bell, // 提醒（响铃态，比 Bell 更生动）
  WarningIcon as AlertCircle, // 警告
  CheckCircleIcon as CheckCircle2, // 成功
  CheckIcon as Check, // 勾选
  CircleNotchIcon as Loader2, // 加载旋转（Phosphor 用 CircleNotch + animate-spin）
  SparkleIcon as Sparkles, // 抽取/魔法
  UserIcon as User, // 用户头像
  RobotIcon as Bot, // AI 头像
  FileTextIcon as FileText, // 文件
} from '@phosphor-icons/react'
