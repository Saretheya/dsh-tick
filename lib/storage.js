/**
 * Tick（定时任务）— 本地存储层（Host 半部内部模块）。
 *
 * 隔离纪律（沿用 DSH 插件 已验证的范式）
 * 1. **唯一写入位置**是本插件自己的 `<插件根>/data/`；
 * 2. **不写** settings.yaml（故不使用 ctx.settings.installSection /
 *    installSection）、不写 sessions/ storages/ .credentials.yaml、
 *    不碰 npm 安装树、不写 cordis.patch.yml；
 * 3. 运行期临时文件放 `data/tmp/`，**不使用 os.tmpdir()**；
 * 4. 写入一律 tmp + rename 原子替换，避免半截文件。
 *
 * ★ 为什么不把任务状态写进会话日志（本项目最重要的架构决策）
 *   dsh-session 有一条 `KNOWN_SESSION_EVENT_TYPES` 白名单，持久化读路径对
 *   "不在白名单且未标 ignorable" 的事件类型 **fail-closed**，会让整份会话
 *   日志被拒读（GUI 报"历史加载失败"）；而 `Session.append()` 只提取
 *   surfaceOp / sourceEventSeqs 两个字段，**插件无法给自己的事件打
 *   ignorable 标记**，官方也明确拒绝了"事件名注册"这条路。
 *   详见
 *
 * 目录布局
 *   data/config.json              插件自有配置（三道闸/开关/时区偏好…）
 *   data/tasks/<sessionId>.json   每会话一份任务表（会话级隔离）
 *   data/tmp/                     运行期临时文件
 *   data/logs/                    运行日志（可选）
 *
 * @module dsh-tick/storage
 */
import { mkdir, readFile, rename, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（本文件位于 <root>/lib/storage.js）。 */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 插件自有数据目录——本插件**唯一**的写入位置。
 *
 * 默认在插件包内（`<root>/data`）。可用环境变量 `DSH_TICK_DATA_DIR` 覆盖，
 * 用途有二
 *   1. **测试隔离**：跑副本/端到端验证时，让副本写自己的目录，
 *      不污染真实实例的状态（踩过：副本与真实实例的 `plugins` 是同一个
 *      junction，于是两者共用 data/，副本里造的测试数据会被真实实例的心跳覆盖）；
 *   2. 多 `DSH_HOME` 场景下按需分开放置。
 *
 * 注意：覆盖值只影响本插件自己的数据目录，不改变"只写自己 data/"这条纪律。
 */
export const DATA_DIR =
  typeof process.env.DSH_TICK_DATA_DIR === 'string' && process.env.DSH_TICK_DATA_DIR.trim().length > 0
    ? process.env.DSH_TICK_DATA_DIR.trim()
    : join(PACKAGE_ROOT, 'data')

export const PATHS = Object.freeze({
  data: DATA_DIR,
  tmp: join(DATA_DIR, 'tmp'),
  logs: join(DATA_DIR, 'logs'),
  tasks: join(DATA_DIR, 'tasks'),
  config: join(DATA_DIR, 'config.json'),
  /**
   * 自定义注入模板——**只在** config 的 `serverPromptLanguage === 'custom'`
   * 时被读取。单独成文件是为了不污染 config.json 的重要配置区
   * （模板动辄几十行）。见 templates.js。
   */
  templates: join(DATA_DIR, 'inject-templates.json'),
})

/** 所有需要预先存在的目录（启动时一次性建好）。 */
const REQUIRED_DIRS = [DATA_DIR, PATHS.tmp, PATHS.logs, PATHS.tasks]

/**
 * 建好插件自有的目录树。只创建目录，不写任何外部路径。
 * @returns 数据目录的绝对路径。
 */
export async function ensureDirs() {
  for (const dir of REQUIRED_DIRS) await mkdir(dir, { recursive: true })
  return DATA_DIR
}

/**
 * 读一个 JSON 文件；不存在或损坏时返回兜底值（不抛错，避免拖垮插件加载）。
 *
 * ⚠ 本函数**无法区分"文件不存在"与"文件损坏"**（两者都返回 fallback）。
 * 需要区分时（例如要隔离损坏文件）请用 `readJsonStrict()`。
 * @param file - 绝对路径。
 * @param fallback - 读取失败时的返回值。
 * @returns 解析后的对象，或兜底值。
 */
export async function readJson(file, fallback = undefined) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 严格读 JSON：把"文件不存在"与"文件损坏"区分开。
 *
 * 之所以需要它：`readJson()` 把两种失败都压成 fallback，调用方就无法判断
 * "这是首次运行"还是"文件坏了"。若把损坏当首次运行，下一次写入会**直接覆盖**
 * 用户数据且毫无痕迹（本插件单元测试实测发现：损坏文件未被隔离）。
 *
 * @param file - 绝对路径。
 * @returns `{ kind: 'missing' }` | `{ kind: 'ok', value }` | `{ kind: 'corrupt', error }`。
 */
export async function readJsonStrict(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    // ENOENT = 文件不存在（首次运行）；其它（EACCES 等）按损坏处理更安全。
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'corrupt', error }
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) }
  } catch (error) {
    return { kind: 'corrupt', error }
  }
}

/**
 * 原子写一个 JSON 文件（tmp + rename），并确保父目录存在。
 * 全程只落在插件自己的 data/ 内。
 *
 * 临时文件放 `data/tmp/`（而不是目标文件旁边）：即使进程被强杀留下半截文件，
 * 也会被启动时的 `sweepTmp()` 清掉，不会污染 `data/` 根目录
 * （实测：踩过：强杀后残留 `*.tmp-<pid>-<ts>`）。
 *
 * @param file - 目标绝对路径。
 * @param value - 可 JSON 序列化的值。
 */
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await mkdir(PATHS.tmp, { recursive: true })
  const tmp = join(PATHS.tmp, `tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * 启动时清理 data/tmp/ 里的残留临时文件（进程崩溃遗留）。
 * 只清插件自己的临时目录。
 * @param maxAgeMs - 超过该年龄的文件才删（默认 1 小时，避免误删正在写的）。
 * @returns 清理掉的文件数。
 */
export async function sweepTmp(maxAgeMs = 3600_000) {
  let removed = 0
  try {
    const entries = await readdir(PATHS.tmp)
    const now = Date.now()
    for (const entry of entries) {
      const full = join(PATHS.tmp, entry)
      try {
        const info = await stat(full)
        if (info.isFile() && now - info.mtimeMs > maxAgeMs) {
          await unlink(full)
          removed += 1
        }
      } catch {
        /* 单个文件失败不影响其它 */
      }
    }
  } catch {
    /* 目录不存在等情况忽略 */
  }
  return removed
}

/**
 * 会话 id → 任务表文件路径。
 *
 * ★ 安全前提：sessionId 会被用作文件名，必须先净化，绝不允许
 * `../` 之类的路径穿越写出 data/ 之外。
 * @param sessionId - 会话 id。
 * @returns 该会话任务表的绝对路径。
 */
export function tasksFileFor(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return join(PATHS.tasks, `${safe}.json`)
}
