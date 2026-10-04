/**
 * model-router — 两挡模型路由扩展（for pi coding agent）
 *
 * 挡位（gear，会话级，session_start 重置为 auto）：
 *   · auto   自动挡——扩展按决策链自动分档并 setModel 切换；
 *   · manual 手动挡——用户锁定模型，路由器完全不干预（/router auto 解除）。
 * 模式（配置级，/router shadow|active 会话内切换）：
 *   · active  真实切换；shadow 只记录推演结果不切换（可回退）。
 *
 * 决策链（decide()，gateChain 逐步留痕，可回放）：
 *   1. classify() 规则分层分类器：prompt 信号打分 → Fast / Balanced / Performance
 *      （先验规则；实测校准走 tools/router_calibrate.py 离线报告 → 人工改常量）
 *   2. 时段闸 timeGate：限免/限时模型仅在指定时段可选（model 为空 = 关闭）
 *   3. 健康闸三级（当前状态 + 近期频次）：
 *      ① 账号级：网关 /status 探测（health.url，可选，不可达/未配置则 fail-open）
 *      ② 模型级：错误反馈冷却窗（error-state.json；限流/不可用短窗）
 *      ③ 频次级：近期错误降权（统计 outcome-log 近窗错误率，超阈值降到池末位——
 *         降权而非剔除：「近期常错」≠「当前不可用」，硬剔除可能把决策逼向 no_viable）
 *   4. failover/轮转冷却：短窗内失败过的模型不可选（跨进程持久）
 *   5. 同档持位 in_tier_hold：当前模型所在档位可行时不乱切
 *   6. 泳道偏好 lanePref：code / knowledge 泳道优先指定候选
 *   7. 级联降档 downgrade：Performance → Balanced → Fast；全空 → tier_exhausted / no_viable
 *
 * 执行期深化（Phase 3）：
 *   · mid-thread 升档——回合内连续工具失败 ≥ midThread.failThreshold ⇒ 任务实为 hard
 *     （起点分类误判），升 1 级（每回合至多 1 次 + 冷却）；成功即归零（连续性才是难度信号）
 *   · 子代理自动分档——subagent 工具按 task 文本独立分档，注入该档锚位
 *     （显式 model 不覆盖；workflow/chain 多子代理不强插）
 *   · 同回合重发——模型级限流且轮转成功后，重放原 prompt（每回合至多 1 次 + 节流）
 *
 * 状态与日志（全部本地文件；决策日志 append-only，8MB 轮转保留一代）：
 *   decision-log.jsonl  每次决策一条：signals/score/rule/tier/gateChain/finalTier/decision…
 *   outcome-log.jsonl   每回合一条：turnResult/errorKind/latencyMs，按 decisionId 关联决策
 *   error-state.json    模型级错误冷却窗；failover-state.json 轮转冷却
 *   tools/router_calibrate.py  离线只读校准报告（样本不足不给结论，防噪声误导）
 *
 * 配置：~/.pi/agent/model-router.config.json（覆盖下方 DEFAULTS；pool 按档位整体覆盖）。
 * 环境变量：PI_CODING_AGENT_DIR（agent 目录）/ MODEL_ROUTER_STATE_DIR（状态目录）/
 *           MODEL_ROUTER_GATEWAY_CONFIG（含 api_key 的网关配置 JSON 路径，仅健康探测用）。
 *
 * 约束：凭据不落盘、决策不进模型上下文、任何异常不阻断会话。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- 配置 ----------

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "model-router.config.json");
const STATE_DIR = process.env.MODEL_ROUTER_STATE_DIR || join(homedir(), ".local", "state", "model-router");
const LOG_PATH = join(STATE_DIR, "decision-log.jsonl");
const LEGACY_LOG_PATH = join(STATE_DIR, "shadow-log.jsonl"); // Phase 0 旧日志保留不并
// 日志轮转上限：decision-log 为 append-only 审计明细（仅追加、无读路径），
// 无界文件对「审计可查性」与备份/传输不利，故设 8MB 上限：
// 超限即原子改名轮转一份 .1（仅保留一代，避免无限膨胀）。
const LOG_MAX_BYTES = 8 * 1024 * 1024;
// 健康探测用的网关鉴权配置（JSON 含 api_key）——经环境变量注入，代码不内置本机路径。
const GATEWAY_CONFIG = process.env.MODEL_ROUTER_GATEWAY_CONFIG ?? "";

const DEFAULTS = {
  enabled: true,
  // active = 自动挡真实切换；shadow = 只记录推演（回退行为）
  mode: "active",
  // 候选池：档内次序 = 优先级（锚位在前，备份/逃生位在后）。
  // 换成你自己的 `<provider>/<modelId>`（与 pi modelRegistry 的 id 一致，例：
  // openai/gpt-4o-mini、anthropic/claude-haiku，或经统一网关的 通道/模型 名）。
  // 档位语义：Fast = 简单问答/轻任务，Balanced = 常规开发，Performance = 难任务。
  pool: {
    Fast: ["your-provider/fast-model", "your-provider/cheap-backup"],
    Balanced: ["your-provider/balanced-model", "your-provider/balanced-backup"],
    Performance: ["your-provider/strong-model"],
  },
  // 时段闸：限免/限时模型白天从候选剔除、夜间恢复；model 为空 = 关闭。
  // 例：{ model: "your-provider/strong-model", startHour: 23, endHour: 8 }
  timeGate: { model: "", startHour: 23, endHour: 8 },
  // 账号级健康探测（可选）：指向网关 /status；空 = 不探测（默认，零网络请求）。
  // 不可达/401 时 fail-open（健康闸自动失效，不影响路由）。
  // 期望响应形：{ "accounts": { "<channel>": [{ "cooling": bool, "disabled": bool }] } }
  health: { url: "", timeoutMs: 600, ttlSec: 60 },
  // 健康探测涉及的通道名（与池项第一段、/status accounts 的键一致）
  channels: ["your-provider"],
  promptPreviewChars: 300,
  // failover/轮转：模型级失败后的冷却与回退语义（primary/fallback 仅作 /router status
  // 展示语义，实际轮转按「池序后继」执行）
  failover: {
    enabled: true,
    primary: "your-provider/balanced-model",
    fallback: "your-provider/balanced-backup",
    cooldownSec: 300, // 模型失败后冷却时长（防双模型循环）
  },
  // 泳道偏好：档内新选模型时的优先候选（in_tier_hold 优先级更高；general 泳道不偏好）
  lanePref: { code: [], knowledge: [] },
  // Phase 3 ① mid-thread 升档——回合内连续工具失败 ≥ 阈值 ⇒ 任务实为 hard（起点分类误判），升 1 级
  midThread: { enabled: true, failThreshold: 3, cooldownSec: 60 },
  // Phase 3 ② 子代理自动分档——subagent 工具按 task 文本独立分档注入 model（显式 model 不覆盖）
  subagentTier: { enabled: true },
  // 模型级错误反馈（限流/不可用短窗冷却）；6004 类错误解析文案中的重置时刻（有则对齐到重置点）
  errorFeedback: {
    enabled: true,
    rateLimitCooldownSec: 180,
    usageWindowMaxSec: 12 * 3600,
    unavailableCooldownSec: 600, // 上游模型不可用短冷却，仅护轮转与同回合重发
    // 健康闸第三级：近期错误反馈感知——冷却态之外的「频次」维度。
    // 动因：error-state 只存当前窗口（过期记录被丢弃），反复限流但窗口短的模型完全不可见。
    recentErrorWindowSec: 3600, // 统计窗口（默认近 1 小时）
    recentErrorMinSamples: 3, // 窗口内至少 N 个样本才启用降权（防小样本噪声）
    recentErrorRateThreshold: 0.34, // 错误率超此值 ⇒ 该模型近期不健康
  },
  // 首选模型 provider 回退：ctx.model 为空（如首消息前）时的兜底，填你的 provider 名
  defaultProvider: "",
};

type Tier = keyof typeof DEFAULTS.pool;
type Cfg = typeof DEFAULTS & { pool: Record<Tier, string[]> };

function loadConfig(): Cfg {
  let user: Record<string, unknown> = {};
  try {
    user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* 无覆盖配置 → 默认 */
  }
  const merged = { ...DEFAULTS, ...user } as Cfg;
  merged.pool = { ...DEFAULTS.pool, ...(user.pool ?? {}) } as Cfg["pool"];
  merged.health = { ...DEFAULTS.health, ...(user.health ?? {}) };
  merged.timeGate = { ...DEFAULTS.timeGate, ...(user.timeGate ?? {}) };
  merged.failover = { ...DEFAULTS.failover, ...(user.failover ?? {}) };
  return merged;
}

// ---------- 会话级状态 ----------

let cfg: Cfg = loadConfig();
let gear: "auto" | "manual" = "auto";
let manualModel: string | null = null;
let segmentSeq = 0;
let segmentReason = "unknown";
let firstOfSegment = true;
let promptedOnce = false;
// router 自动切换的防误判标志（setModel 会同步 emit model_select）
let routerSwitching = false;
let lastRouterSwitchAt = 0;
// 健康探测缓存
let healthCache: { at: number; data: HealthResult } | null = null;

// ---------- 规则分层分类器（v0 先验，Phase 2 用 outcome 数据校准） ----------

const HARD = /架构|根因|深入|调研|权衡|性能|排查|迁移|系统性|容量|并发|安全|设计(方案|评审)|基准|A\/B|benchmark|architecture|root cause|investigat|trade-?off|deep dive/gi;
const AGENTIC = /修复|实现|重构|部署|提交|调试|改(造|写)|编写|集成|回滚|排查(不了)?|fix|implement|refactor|debug|deploy|migrat(?!ion)|测试用例|写(个|一个)(脚本|工具)|删除(文件|目录)/gi;
const EASY = /是什么|什么是|列(出|一下)|翻译|格式化|重命名|总结|摘要|查一下|解释(一下)?|快速|多少钱|几点|what is|define|quickly|tl;?dr/gi;
// P2-3 泳道信号（与分档 score 正交：不改档，只决定档内偏好）
const LANE_CODE = /代码|函数|脚本|修复|实现|重构|调试|编译|报错|bug|接口|\bapi\b|正则|sql|python|typescript|javascript|bash|终端|命令行|部署|测试|算法|数据结构/gi;
const LANE_KNOWLEDGE = /是什么|什么是|为什么|区别|比较|对比|原理|概念|定义|历史|背景|论文|文献|解释|知识|评测|科普|指南|教程/gi;

function classify(prompt: string) {
  const chars = [...prompt].length;
  const hard = (prompt.match(HARD) ?? []).length;
  const agentic = (prompt.match(AGENTIC) ?? []).length;
  const easy = (prompt.match(EASY) ?? []).length;
  const codeBlock = prompt.includes("```");
  const lengthBand = chars >= 4000 ? 2 : chars >= 1000 ? 1 : 0;
  const score = hard * 2 + agentic + codeBlock + lengthBand - easy * 2;

  // 保守优先：歧义一律 Balanced（避免 fast-only 失败模式）
  let tier: Tier = "Balanced";
  let rule = "default_balanced";
  if (hard >= 1 && score >= 3) {
    tier = "Performance";
    rule = "perf_hard";
  } else if (easy >= 1 && agentic === 0 && hard === 0 && chars < 600) {
    tier = "Fast";
    rule = "fast_easy";
  } else if (score >= 1) {
    tier = "Balanced";
    rule = "balanced_score";
  }
  const confidence =
    (tier === "Performance" && score >= 4) || (tier === "Fast" && score <= -4) ? "high" : "low";

  // P2-3 泳道判定：两类信号均 ≥2 且严格占优才归类，否则 general（保守）
  const codeLane = (prompt.match(LANE_CODE) ?? []).length;
  const knowledgeLane = (prompt.match(LANE_KNOWLEDGE) ?? []).length;
  const lane =
    codeLane >= 2 && codeLane > knowledgeLane
      ? "code"
      : knowledgeLane >= 2 && knowledgeLane > codeLane
        ? "knowledge"
        : "general";

  return {
    signals: { hard, agentic, easy, codeBlock, lengthBand, chars },
    score,
    rule,
    tier,
    confidence,
    lane,
    laneSignals: { codeLane, knowledgeLane },
  };
}

// ---------- 时段 gate ----------

function isNight(hour: number, gate: Cfg["timeGate"]) {
  return hour >= gate.startHour || hour < gate.endHour;
}

// ---------- 渠道健康闸 ----------

interface HealthResult {
  status: "ok" | "http_error" | "unknown";
  err?: string;
  channels: Record<string, boolean>;
}

// 模型解析：优先按 provider 精确查（单 provider/网关式布局）；
// 回退到全注册表按 `provider/model` 或裸 id 匹配（多 provider 布局）。
// 找不到返回 undefined ⇒ 上层落 decision=model_not_found，不阻断会话。
function resolveModel(
  registry: { find(provider: string, id: string): unknown; getAll(): unknown[] },
  provider: string | undefined,
  id: string,
) {
  if (provider) {
    const hit = registry.find(provider, id);
    if (hit) return hit;
  }
  const all = registry.getAll() as Array<{ provider: string; id: string }>;
  return all.find((x) => `${x.provider}/${x.id}` === id) ?? all.find((x) => x.id === id);
}

function channelOf(modelId: string) {
  return modelId.split("/")[0] ?? "";
}

async function probeHealth(c: Cfg): Promise<HealthResult> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < c.health.ttlSec * 1000) return healthCache.data;
  let data: HealthResult = { status: "unknown", channels: {} };
  if (!c.health.url) {
    healthCache = { at: now, data }; // 未配置健康探测 → fail-open（不发网络请求）
    return data;
  }
  try {
    let key = "";
    try {
      if (GATEWAY_CONFIG) key = String(JSON.parse(readFileSync(GATEWAY_CONFIG, "utf8")).api_key ?? "");
    } catch {
      /* config 不可读 → 401 → http_error */
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), c.health.timeoutMs);
    try {
      const res = await fetch(c.health.url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctl.signal,
      });
      if (!res.ok) {
        data = { status: "http_error", err: `HTTP ${res.status}`, channels: {} };
      } else {
        const body = (await res.json()) as { accounts?: Record<string, unknown[]> };
        const channels: Record<string, boolean> = {};
        for (const ch of c.channels) {
          const list = Array.isArray(body.accounts?.[ch])
            ? (body.accounts[ch] as Array<Record<string, unknown>>)
            : [];
          channels[ch] = list.some((a) => !a.cooling && !a.disabled);
        }
        data = { status: "ok", channels };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    data = { status: "unknown", err: String(e).slice(0, 160), channels: {} };
  }
  healthCache = { at: now, data };
  return data;
}

// ---------- P2-1 错误反馈：模型级限流短窗（与 failover-state 并列命名空间） ----------

const ERROR_STATE_PATH = join(STATE_DIR, "error-state.json");

interface ErrorWindow {
  until: number; // 模型不可选截止时刻（ms）
  reason: string; // 错误特征类（rate_limit / usage_window）
  detail: string; // 原文摘录（截断）
  count?: number; // 连续命中计数（升级用）
  lastAt?: number;
}

function loadErrorState(): Map<string, ErrorWindow> {
  try {
    const raw = JSON.parse(readFileSync(ERROR_STATE_PATH, "utf8")) as Record<string, ErrorWindow>;
    const m = new Map<string, ErrorWindow>();
    const now = Date.now();
    for (const [k, w] of Object.entries(raw)) if (w.until > now) m.set(k, w); // 只留未过期
    return m;
  } catch {
    return new Map();
  }
}

const errState: Map<string, ErrorWindow> = loadErrorState();

function persistErrorState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const obj: Record<string, ErrorWindow> = {};
    for (const [k, w] of errState) obj[k] = w;
    writeFileSync(ERROR_STATE_PATH, JSON.stringify(obj), { mode: 0o600 });
  } catch {
    /* 状态持久化失败不阻断 */
  }
}

function isErrorCooling(modelId: string): boolean {
  const w = errState.get(modelId);
  return !!w && w.until > Date.now();
}

// ---------- Phase 3（v0.10.0）：近期错误反馈感知 ----------
// 【统一健康闸的第三级】前两级 = 账号级 /status（probeHealth）+ 模型级冷却窗（error-state）;
//   两者都只看**当前状态**，看不见「反复限流但窗口短」的模型（过期记录被丢弃后无任何历史频次）。
//   第三级补 **频次维度**：读 outcome-log.jsonl（v0.9.0 起的回合级真实 outcome），
//   统计每个模型在最近 window 内的错误率，超阈值者在决策时降权（不删出池——保留为末位逃生）。
// 【为什么读 outcome-log 而不另建状态文件】单一数据源（DRY），且它是**已持久化的真实 outcome**，
//   正合报告 §七 Phase 3「近期错误反馈感知」原意；新增状态文件只会造成又一处待同步的真相。
interface RecentErrStats {
  samples: number;
  errors: number;
  rateLimits: number;
}
let recentErrCache: { at: number; stats: Map<string, RecentErrStats> } | null = null;
const RECENT_ERR_CACHE_TTL_MS = 30_000; // 每 30s 最多重算一次（文件可能增长，但无需逐决策读）

/** 扫描 outcome-log 尾部，统计近 windowSec 内每个模型的错误率（失败静默：无 outcome 数据则退化为不降权） */
function loadRecentErrors(windowSec: number): Map<string, RecentErrStats> {
  const now = Date.now();
  if (recentErrCache && now - recentErrCache.at < RECENT_ERR_CACHE_TTL_MS) return recentErrCache.stats;
  const stats = new Map<string, RecentErrStats>();
  try {
    const raw = readFileSync(OUTCOME_LOG_PATH, "utf8");
    const cut = now - windowSec * 1000;
    // 只解析尾部（近期记录在末尾；全量解析在大文件上是浪费）
    const lines = raw.split("\n").slice(-2000);
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== "turn_outcome") continue;
      const ts = Date.parse(String(rec.ts ?? ""));
      if (!Number.isFinite(ts) || ts < cut) continue;
      const m = String(rec.model ?? "");
      if (!m || m === "?") continue;
      const s = stats.get(m) ?? { samples: 0, errors: 0, rateLimits: 0 };
      s.samples += 1;
      if (rec.turnResult === "error") s.errors += 1;
      if (rec.errorKind === "rate_limit") s.rateLimits += 1;
      stats.set(m, s);
    }
  } catch {
    /* outcome-log 不存在/不可读 → 空表（降级为不降权，安全方向） */
  }
  recentErrCache = { at: now, stats };
  return stats;
}

/** 该模型近期是否不健康（样本足够多且错误率超阈值） */
function isRecentErrorProne(modelId: string, c: Cfg): boolean {
  const ef = c.errorFeedback;
  if (!ef.enabled) return false;
  const s = loadRecentErrors(ef.recentErrorWindowSec).get(modelId);
  if (!s || s.samples < ef.recentErrorMinSamples) return false;
  return s.errors / s.samples >= ef.recentErrorRateThreshold;
}

/**
 * P2-1：解析模型级错误文本 → 模型短窗冷却。
 * 返回 null 表示不属模型级限流（如 no_healthy_account 账号级，已由 /status 健康闸覆盖，不重复惩罚）。
 * 已知形态：①带 body：'429: {"code":6004,"msg":"您的使用量…将在 <时刻> 重置…"}' 或 FreeUsageLimitError JSON；
 *       ②不透明：openai SDK 流式首包错误吞掉 body → '429 status code (no body)' —— 无法区分 6004/14003，
 *         用连续计数升级逼近（1次→3min，2次→30min，≥3次→12h；6004 是模型级长窗、14003 短窗，均可被覆盖）。
 */
function classifyModelError(msg: string, c: Cfg): { window: ErrorWindow; kind: string } | null {
  if (!c.errorFeedback.enabled) return null;
  const text = String(msg ?? "");
  // ①窗口型带 body：中文「您的使用量已超出频率限制，将在 <时刻> 重置」与英文
  //   「usage exceeds frequency limit ... will reset at <时刻> UTC+8」同语义（DRY，中英同列）。
  //   v0.10.1 修复：原正则只匹配中文形态，英文 6004（dp4.1 实弹 07:33 撞窗实测）漏判 ⇒
  //   冷却窗丢失，同模型在重置前被反复尝试（每次撞窗 = 浪费一回合）。
  const m6004 = text.match(/(使用量|用量|usage\s+exceeds?\s+frequency|usage\s+limit).*?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
  if (m6004) {
    const reset = Date.parse(m6004[2].replace(" ", "T"));
    let until = Number.isNaN(reset) ? 0 : reset;
    // 网关报 UTC+8 时刻；Date.parse 无时区后缀按本地时区解析，本机 = Asia/Shanghai(+8) ⇒ 等价。
    // 上限放宽到 24h（usageWindowMaxSec=12h 是窗口长度先验，重置时刻可能略超）
    if (!until || until - Date.now() > c.errorFeedback.usageWindowMaxSec * 2 * 1000) {
      until = Date.now() + c.errorFeedback.usageWindowMaxSec * 1000;
    }
    return { kind: "usage_window", window: { until, reason: "usage_window", detail: text.slice(0, 160), count: 1, lastAt: Date.now() } };
  }
  // ②上游模型不可用型（非限流）：'Upstream request failed: Model is unavailable.'——短冷却，
  //   主要目的是让轮转目标跳开 + 同回合 requeue 在新锚位上重发（否则 easy 首锚撞它会裸失败）
  if (/model is unavailable/i.test(text)) {
    return {
      kind: "unavailable",
      window: {
        until: Date.now() + (c.errorFeedback as Record<string, number>).unavailableCooldownSec * 1000,
        reason: "unavailable",
        detail: text.slice(0, 160),
        count: 1,
        lastAt: Date.now(),
      },
    };
  }
  // ③限流型：带 body 关键词 或 不透明 status-code 形态（'429 status code (no body)' / '429: {…}'）
  const hasKw = /FreeUsageLimitError|too many requests|rate.?limit/i.test(text);
  const opaque429 = /\b429\s*(status code|:)|429[^\d]{0,40}\(no body\)/.test(text);
  if (hasKw || opaque429) {
    return {
      kind: "rate_limit",
      window: {
        until: Date.now() + c.errorFeedback.rateLimitCooldownSec * 1000,
        reason: "rate_limit",
        detail: text.slice(0, 160),
        count: 1,
        lastAt: Date.now(),
      },
    };
  }
  return null;
}

function markModelError(modelId: string, msg: string, c: Cfg): { kind: string; window: ErrorWindow } | null {
  const r = classifyModelError(msg, c);
  if (!r) return null;
  const prev = errState.get(modelId);
  let w = r.window;
  if (prev && r.kind === "rate_limit" && prev.reason === "rate_limit") {
    // 连续命中升级（仅在旧窗未过期时累计；过期则重新计数）
    const chain = prev.until > Date.now() ? (prev.count ?? 1) + 1 : 1;
    const sec =
      chain >= 3
        ? c.errorFeedback.usageWindowMaxSec
        : chain === 2
          ? 30 * 60
          : c.errorFeedback.rateLimitCooldownSec;
    w = { until: Date.now() + sec * 1000, reason: "rate_limit", detail: r.window.detail, count: chain, lastAt: Date.now() };
  } else if (!prev || w.until > prev.until) {
    // 保留原计数升级逻辑：取更晚的截止时刻（冷却不倒退）
  } else {
    w = prev;
  }
  errState.set(modelId, w);
  persistErrorState();
  return { kind: r.kind, window: w };
}

// ---------- P2-4 outcome 统计（进程内会话累计，/router stats 展示） ----------

const outcomes = { turns: 0, errors: 0, modelErrors: 0, retriedTurns: 0, laneCount: { code: 0, knowledge: 0, general: 0 }, midThreadUpgrades: 0, subagentTiered: 0 };
let lastTurnHadError = false;
let lastTurnModelErrKind: string | null = null;
// Phase 3：mid-thread 升档状态（回合内连续工具失败计数；agent_end 归零）
let toolFailStreak = 0;
let upgradedThisTurn = false;
let lastUpgradeAt = 0; // 升档冷却独立计时——不能复用 lastRouterSwitchAt（开局 setModel 也刷新它，会把首回合升级永久压制）

// ---------- P2-4 后半：回合级 outcome 落盘（校准分类器的数据基础） ----------
// 【动因】原 outcomes 仅**进程内计数**（/router stats），进程退出即失；且决策日志无 outcome 字段
//   ⇒ 无法回答「某档/某模型实际成功率多少」，分类器只能纯规则打分（报告 §十一 自述「校准未完成期」）。
// 【设计】回合边界（agent_end）落一条 outcome 记录，用 decisionId 关联当回合的决策记录。
//   只记**可从事件直接观测**的信号，不做质量启发式推断（噪声大，待数据验证后再议）：
//     turnResult   ok | error          本回合是否出现过 assistant stopReason=error
//     errorKind    模型级错误类型（rate_limit / unavailable / …）或 null
//     neededRequeue 是否因错误触发了重发（P2-2 requeue）
//     latencyMs    决策时刻 → 回合结束的墙钟耗时
const OUTCOME_LOG_PATH = join(STATE_DIR, "outcome-log.jsonl");
const OUTCOME_LOG_MAX_BYTES = 8 * 1024 * 1024; // 与 decision-log 同量级；实测 ~106KB/161 条 ⇒ 上限充裕
let pendingDecisionId: string | null = null;
let pendingDecisionAt = 0;
let pendingDecisionModel: string | null = null;
let pendingDecisionTier: string | null = null;
let pendingRequeue = false;
let outcomeSeq = 0;

/** 生成决策 id：时间戳 + 进程内序号，保证同进程内唯一且可读（decision-log 与 outcome-log 交叉引用） */
function newDecisionId(): string {
    return `${Date.now().toString(36)}-${(++outcomeSeq).toString(36)}`;
}

function rotateOutcomeLogIfNeeded() {
    try {
        if (statSync(OUTCOME_LOG_PATH).size < OUTCOME_LOG_MAX_BYTES) return;
        renameSync(OUTCOME_LOG_PATH, `${OUTCOME_LOG_PATH}.1`);
    } catch {
        /* 文件不存在等——静默 */
    }
}

/** 写一条 outcome（失败静默：审计日志不得影响主流程，与 appendLog 同纪律） */
function appendOutcome(rec: Record<string, unknown>) {
    try {
        mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
        rotateOutcomeLogIfNeeded();
        appendFileSync(OUTCOME_LOG_PATH, JSON.stringify(rec) + "\n", { mode: 0o600, encoding: "utf8" });
    } catch (e) {
        try {
            process.stderr.write(`[model-router] outcome write failed: ${String(e).slice(0, 160)}\n`);
        } catch {
            /* swallow */
        }
    }
}
// P2-2 同回合重发控制：每回合至多 1 次，仅模型级限流错误触发；60s 节流防连环重放
let lastPrompt = "";
let lastPromptAt = 0;
let requeuedThisTurn = false;
let lastRequeueAt = 0;

// ---------- 决策：分档 → 时段 gate → 健康过滤 → 错误反馈过滤 → 同档 hold → 级联降档 ----------

interface Decision {
  tier: Tier;
  downgradedFrom: Tier | null;
  model: string | null; // 期望模型 id（无 provider 前缀）
  candidates: string[];
  chain: string[];
  health: HealthResult;
  night: boolean;
}

const TIER_DESCENT: Tier[] = ["Performance", "Balanced", "Fast"];

function candidatesFor(tier: Tier, night: boolean, c: Cfg): string[] {
  // Performance 池若被时段闸剔空 → decide() 自然级联降档 Balanced（级联兜底）
  return c.pool[tier];
}

async function decide(
  cls: { tier: Tier },
  currentModelId: string,
  hour: number,
  c: Cfg,
): Promise<Decision> {
  const night = isNight(hour, c.timeGate);
  const health = await probeHealth(c);
  const chain: string[] = [];
  const startIdx = TIER_DESCENT.indexOf(cls.tier);

  let picked: string | null = null;
  let finalTier: Tier = cls.tier;
  let downgradedFrom: Tier | null = null;
  let lastCandidates: string[] = [];

  for (let i = startIdx; i < TIER_DESCENT.length; i++) {
    const t = TIER_DESCENT[i];
    let cands = candidatesFor(t, night, c);
    // 时段 gate：白天剔除限免模型（防御性兜底）
    cands = cands.filter((m) => !(m === c.timeGate.model && !night));
    lastCandidates = cands;
    const viable0 =
      health.status === "ok" ? cands.filter((m) => health.channels[channelOf(m)] !== false) : cands;
    if (viable0.length < cands.length) chain.push(`filtered_by_health:${cands.length}->${viable0.length}`);
    // failover 冷却中的模型不可选（含 in_tier_hold 的 current 自身）
    const viable1 = viable0.filter((m) => !isCooling(m));
    if (viable1.length < viable0.length) chain.push(`filtered_by_failover:${viable0.length}->${viable1.length}`);
    // P2-1：错误反馈短窗中的模型不可选（模型级限流，/status 健康闸盲区补偿）
    const viable = viable1.filter((m) => !isErrorCooling(m));
    if (viable.length < viable1.length) chain.push(`filtered_by_error:${viable1.length}->${viable.length}`);
    // Phase 3（v0.10.0）：近期错误反馈感知——**降权而非剔除**。
    // 设计取舍：这类模型是「近期常错」而非「当前不可用」，仍可能是当前唯一可行候选；
    //   直接剔除会在候选稀疏时把决策逼向 no_viable（比用一个爱出错的模型更糟）。
    //   故仅把它**排到末位**，保留为逃生位，并在 gateChain 留痕供离线校准复核。
    let ranked = viable;
    if (viable.length > 1) {
      const depri = viable.filter((m) => isRecentErrorProne(m, c));
      if (depri.length > 0 && depri.length < viable.length) {
        ranked = [...viable.filter((m) => !depri.includes(m)), ...depri];
        chain.push(`deprioritized_recent_error:${depri.length}`);
      }
    }
    if (ranked.length > 0) {
      // 同档免切换：当前模型仍可行则保持（避免无谓抖动）
      if (ranked.includes(currentModelId)) {
        picked = currentModelId;
        chain.push(`in_tier_hold:${currentModelId}`);
      } else {
        // P2-3 泳道偏好：档内新选时优先可行候选（不改变档与候选集）
        const pref = (c.lanePref as Record<string, string[]>)[cls.lane] ?? [];
        const lanePick = pref.find((m) => ranked.includes(m));
        picked = lanePick ?? ranked[0];
        if (lanePick) chain.push(`lane_pref:${cls.lane}:${lanePick}`);
        if (i !== startIdx) {
          downgradedFrom = cls.tier;
          chain.push(`downgrade:${cls.tier}->${t}(channel_or_gate)`);
        }
      }
      finalTier = t;
      break;
    }
    chain.push(`tier_exhausted:${t}(candidates=${cands.length})`);
  }

  if (!picked) chain.push("no_viable_model");
  return { tier: finalTier, downgradedFrom, model: picked, candidates: lastCandidates, chain, health, night };
}

// ---------- failover（错误驱动的候选轮转；跨进程持久冷却） ----------

const FAILOVER_STATE_PATH = join(STATE_DIR, "failover-state.json");

function loadFailState(): Map<string, number> {
  try {
    const raw = JSON.parse(readFileSync(FAILOVER_STATE_PATH, "utf8")) as Record<string, number>;
    const m = new Map<string, number>();
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) if (v > now) m.set(k, v); // 只留未过期
    return m;
  } catch {
    return new Map();
  }
}

const failState: Map<string, number> = loadFailState();

function persistFailState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const obj: Record<string, number> = {};
    for (const [k, v] of failState) obj[k] = v;
    writeFileSync(FAILOVER_STATE_PATH, JSON.stringify(obj), { mode: 0o600 });
  } catch {
    /* 状态持久化失败不阻断 */
  }
}

function isCooling(modelId: string): boolean {
  const u = failState.get(modelId);
  return !!u && Date.now() < u;
}

function markFailed(modelId: string, c: Cfg) {
  failState.set(modelId, Date.now() + c.failover.cooldownSec * 1000);
  persistFailState();
}

// ---------- P2-2 池内轮转：pair 优先，否则按池序取后继（跨档允许，日志记 cross_tier） ----------

function tierOf(modelId: string, c: Cfg): Tier | null {
  for (const t of TIER_DESCENT) if (c.pool[t].includes(modelId)) return t;
  return null;
}

function rotationTarget(curId: string, c: Cfg): { to: string | null; crossTier: boolean } {
  const curTier = tierOf(curId, c);
  if (!curTier) return { to: null, crossTier: false }; // 越池模型（手动强制）不轮转
  const order: Tier[] = [curTier, ...TIER_DESCENT.filter((t) => t !== curTier)];
  const seq = order.flatMap((t) => c.pool[t]);
  const idx = seq.indexOf(curId);
  for (let i = 1; i <= seq.length; i++) {
    const cand = seq[(idx + i) % seq.length];
    if (cand === curId) break;
    if (!isCooling(cand) && !isErrorCooling(cand)) {
      const candTier = tierOf(cand, c)!;
      return { to: cand, crossTier: candTier !== curTier };
    }
  }
  return { to: null, crossTier: false };
}

// ---------- 审计日志 ----------

// ── Phase 3 ①：mid-thread 升档（报告 §七）──
// 第一性原理：分类器只看回合起点的 prompt 文本，而任务真实难度在执行中暴露——
// 规划段像 easy/Fast 的任务，连续撞工具失败即实为 agentic/hard。负反馈若不打破：
// 弱档 → 更多失败 → 继续弱档。设计：
//   · 「连续」失败计数（一次 tool_result ok 即归零）——连续性才是难度信号，偶发失败是噪声；
//   · 每回合至多升 1 级（防振荡：升档后新模型需要时间证明自己）；
//   · 升档后 cooldownSec 冷却（不因旧模型的遗留失败立即再升）。
const UPGRADE_PATH: Record<Tier, Tier | null> = { Fast: "Balanced", Balanced: "Performance", Performance: null };

function upgradeTierForStreak(curTier: Tier, c: Cfg): { tier: Tier; from: Tier } | null {
  const mt = c.midThread;
  if (!mt.enabled) return null;
  if (toolFailStreak < mt.failThreshold) return null;
  if (upgradedThisTurn) return null;
  if (Date.now() - lastUpgradeAt < mt.cooldownSec * 1000) return null;
  const next = UPGRADE_PATH[curTier];
  if (!next) return null;
  return { tier: next, from: curTier };
}

function appendLog(rec: Record<string, unknown>) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    rotateLogIfNeeded();
    appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n", { mode: 0o600, encoding: "utf8" });
  } catch (e) {
    try {
      process.stderr.write(`[model-router] log write failed: ${String(e).slice(0, 160)}\n`);
    } catch {
      /* swallow */
    }
  }
}

/** 无界日志的界：超 LOG_MAX_BYTES 则轮转一份 .1（保留一代）。失败静默——审计日志不得影响主流程。 */
function rotateLogIfNeeded() {
  try {
    if (statSync(LOG_PATH).size < LOG_MAX_BYTES) return;
    renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    /* 文件不存在（首写）或改名失败：交由后续 append 自然处理 */
  }
}

function logGear(trigger: string, extra: Record<string, unknown> = {}) {
  appendLog({
    ts: new Date().toISOString(),
    type: "gear_change",
    gear,
    routerMode: cfg.mode,
    segment: segmentSeq,
    trigger,
    ...extra,
  });
}

// ---------- P2-4：/router stats 子命令实现 ----------

function statsMessage(c: Cfg): string {
  const errCooling = [...errState.entries()]
    .filter(([, w]) => w.until > Date.now())
    .map(([k, w]) => `${k}[${w.reason}](至 ${new Date(w.until).toISOString().slice(11, 19)}Z)`)
    .join(", ");
  return [
    `Model Router — Phase 2 统计（进程内会话累计）`,
    `回合: ${outcomes.turns} | 含错误回合: ${outcomes.retriedTurns} | 模型级限流命中: ${outcomes.modelErrors}（错误事件累计 ${outcomes.errors}）`,
    `泳道分布: code=${outcomes.laneCount.code} knowledge=${outcomes.laneCount.knowledge} general=${outcomes.laneCount.general}`,
    `Phase 3 深化: mid-thread 升档 ${outcomes.midThreadUpgrades} 次 | 子代理分档注入 ${outcomes.subagentTiered} 次`,
    `错误反馈窗（P2-1）: ${errCooling || "无"}`,
    `（跨进程持久决策明细: ${LOG_PATH}；回合 outcome: ${OUTCOME_LOG_PATH}；error-state: ${ERROR_STATE_PATH}）`,
  ].join("\n");
}

// ---------- 扩展入口 ----------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event) => {
    segmentSeq += 1;
    segmentReason = event.reason;
    firstOfSegment = true;
    gear = "auto";
    manualModel = null;
    // resume/fork/reload：延续用户语境，其后的 model_select 视为手动强制
    promptedOnce = event.reason === "resume" || event.reason === "fork" || event.reason === "reload";
    routerSwitching = false;
    lastRouterSwitchAt = 0;
    healthCache = null;
    cfg = loadConfig(); // 新会话重读配置文件（/router 的会话内改动仅影响本会话内存态）
  });

  // 手动挡触发：任何非 router 的、发生在用户消息之后的模型选择
  pi.on("model_select", (event) => {
    if (routerSwitching || Date.now() - lastRouterSwitchAt < 1000) return; // router 自动切换
    if (!promptedOnce) return; // 启动/新会话的初始模型选择不算强制
    const id = `${event.model.provider}/${event.model.id}`;
    if (gear === "manual" && manualModel === id) return; // 重复选择同一模型
    gear = "manual";
    manualModel = id;
    logGear("model_select", { model: id });
  });

  // 自动挡决策 + 执行（shadow 只记录）
  pi.on("before_agent_start", async (event, ctx) => {
    if (!cfg.enabled) return;
    requeuedThisTurn = false; // 新回合重置同回合重发窗口
    lastPrompt = event.prompt;
    lastPromptAt = Date.now();
    const ts = new Date().toISOString();
    const hour = new Date().getHours();
    const first = !firstOfSegment;
    firstOfSegment = false;
    promptedOnce = true;
    try {
      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
      const currentId = ctx.model?.id ?? "unknown";
      const cls = classify(event.prompt);
      // P2-4 后半：本回合决策 id（写入决策日志，回合结束时由 outcome 记录引用）
      const decisionId = newDecisionId();
      pendingDecisionId = decisionId;
      pendingDecisionAt = Date.now();
      pendingDecisionModel = currentId;
      pendingDecisionTier = cls.tier;
      pendingRequeue = false;
      const base = {
        ts,
        decisionId,
        mode: cfg.mode,
        gear,
        segment: segmentSeq,
        segmentReason,
        firstOfSegment: first,
        cwd: process.cwd(),
        envModel: process.env.PI_MODEL ?? null,
        currentModel,
        toolCount: event.systemPromptOptions?.selectedTools?.length ?? 0,
        hour,
        ...cls,
        promptPreview: [...event.prompt].slice(0, cfg.promptPreviewChars).join(""),
      };

      // 手动挡：不干预，仅记录
      if (gear === "manual") {
        appendLog({
          ...base,
          night: isNight(hour, cfg.timeGate),
          gateChain: ["manual_gear"],
          wouldSwitchTo: null,
          decision: "manual_locked",
          manualModel,
        });
        return;
      }

      // 自动挡：决策链
      const dec = await decide(cls, currentId, hour, cfg);
      let decision: string;
      let switchedTo: string | null = null;
      let setOk: boolean | null = null;

      if (dec.model === null) {
        decision = "no_viable";
      } else if (dec.model === currentId) {
        decision = "no_change";
      } else if (cfg.mode === "shadow") {
        decision = "would_switch";
      } else {
        const target = resolveModel(ctx.modelRegistry, ctx.model?.provider ?? cfg.defaultProvider, dec.model);
        if (!target) {
          decision = "model_not_found";
        } else {
          routerSwitching = true;
          try {
            setOk = await pi.setModel(target);
          } finally {
            routerSwitching = false;
            lastRouterSwitchAt = Date.now();
          }
          if (setOk) {
            decision = "switched";
            switchedTo = `${target.provider}/${target.id}`;
          } else {
            decision = "switch_failed";
          }
        }
      }

      appendLog({
        ...base,
        night: dec.night,
        health: { status: dec.health.status, channels: dec.health.channels, err: dec.health.err },
        gateChain: dec.chain,
        finalTier: dec.tier,
        downgradedFrom: dec.downgradedFrom,
        candidates: dec.candidates,
        wouldSwitchTo: dec.model,
        decision,
        switchedTo,
        setOk,
      });
    } catch (e) {
      appendLog({ ts, stage: "before_agent_start", err: String(e).slice(0, 300) });
    }
  });

  // ── Phase 3 ①+②（v0.11.0）：工具调用观测（mid-thread 升档）+ 子代理自动分档（报告 §七）──
  pi.on("tool_call", async (event, ctx) => {
    try {
      // ② 子代理自动分档：按 task 文本独立分档，注入该档锚位模型（DRY：复用 classify）。
      //    显式 model 不覆盖——以调用方显式指定为准，路由器只做缺省推断；workflow/chain 多子代理不强插。
      if (cfg.subagentTier.enabled && event.toolName === "subagent" && gear === "auto") {
        const input = event.input as { task?: string; model?: string; agent?: string; action?: string; chain?: unknown; tasks?: unknown };
        const task = typeof input.task === "string" ? input.task : "";
        const singleChild = task && input.agent && !input.action && !input.chain && !input.tasks;
        if (singleChild && input.model === undefined) {
          const cls = classify(task);
          const cands = candidatesFor(cls.tier, isNight(new Date().getHours(), cfg.timeGate), cfg);
          const anchor = cands[0];
          if (anchor) {
            input.model = anchor;
            outcomes.subagentTiered += 1;
            appendLog({
              ts: new Date().toISOString(), type: "subagent_tier",
              taskPreview: [...task].slice(0, 60).join(""),
              tier: cls.tier, rule: cls.rule, score: cls.score, lane: cls.lane,
              model: anchor, agent: input.agent ?? null, gear,
            });
          }
        }
      }
      // 注：成功归零在 tool_result（!isError → 0）——tool_call 在执行前，成败未知，不可在此归零
      //（否则序列 fail→归零→fail→归零，streak 永远到不了阈值）。
    } catch (e) {
      appendLog({ ts: new Date().toISOString(), stage: "tool_call", err: String(e).slice(0, 300) });
    }
  });

  // ① mid-thread 升档：连续工具失败 ≥ 阈值 ⇒ 任务实为 hard/agentic（起点分类误判），升 1 级
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!cfg.midThread.enabled) return;
      if (!event.isError) { toolFailStreak = 0; return; }
      toolFailStreak += 1;
      if (gear === "manual") return; // 手动挡绝对优先：用户锁的模型不由路由器擅动
      const mt = cfg.midThread;
      const curId = ctx.model?.id;
      const curTier = curId ? tierOf(curId, cfg) : null;
      if (!curId || !curTier) return;
      const up = upgradeTierForStreak(curTier, cfg);
      if (!up) return;
      const cands = candidatesFor(up.tier, isNight(new Date().getHours(), cfg.timeGate), cfg);
      const targetId = cands[0];
      if (!targetId || targetId === curId) return;
      const target = resolveModel(ctx.modelRegistry, ctx.model?.provider, targetId);
      if (!target) return;
      routerSwitching = true;
      let ok = false;
      try {
        ok = await pi.setModel(target);
      } finally {
        routerSwitching = false;
        lastRouterSwitchAt = Date.now();
      }
      if (!ok) return;
      upgradedThisTurn = true; // 每回合至多 1 次（防振荡）
      lastUpgradeAt = Date.now(); // 升档专用冷却起点（区别于普通 setModel）
      outcomes.midThreadUpgrades += 1;
      appendLog({
        ts: new Date().toISOString(), type: "mid_thread_upgrade",
        from: curId, to: targetId, fromTier: curTier, toTier: up.tier,
        failStreak: toolFailStreak, threshold: mt.failThreshold, gear,
      });
    } catch (e) {
      appendLog({ ts: new Date().toISOString(), stage: "mid_thread", err: String(e).slice(0, 300) });
    }
  });

  // failover/轮转钩子：模型级错误 → 错误反馈入态（P2-1）+ 池内轮转（P2-2；手动挡不干预，留给用户强制意志）
  pi.on("message_end", async (event, ctx) => {
    try {
      const m = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
      if (m?.role !== "assistant" || m.stopReason !== "error") return;
      const cur = ctx.model?.id;
      if (!cur) return;
      outcomes.errors += 1;
      lastTurnHadError = true;
      // P2-1：模型级限流特征 → 短窗冷却（账号级错误如 no_healthy_account 不入，由 /status 健康闸覆盖）
      const ef = markModelError(cur, m.errorMessage ?? "", cfg);
      if (ef) {
        outcomes.modelErrors += 1;
        lastTurnModelErrKind = ef.kind;
        appendLog({
          ts: new Date().toISOString(), type: "error_feedback", model: cur,
          kind: ef.kind, until: new Date(ef.window.until).toISOString(),
          detail: ef.window.detail, gear,
        });
      }
      // P2-2：池内轮转（failover 对内相邻语义保留）；越池模型不碰
      if (!tierOf(cur, cfg)) return;
      markFailed(cur, cfg); // 池内模型错误即冷却，防轮转回弹
      const skipped = gear === "manual" ? "manual_gear" : null;
      if (skipped) {
        appendLog({ ts: new Date().toISOString(), type: "failover", from: cur, decision: "skipped", reason: skipped });
        return;
      }
      const { to: partner, crossTier } = rotationTarget(cur, cfg);
      if (!partner) {
        appendLog({
          ts: new Date().toISOString(), type: "failover", from: cur, to: null,
          decision: "exhausted", reason: "message_end_error", gear,
        });
        return;
      }
      const target = resolveModel(ctx.modelRegistry, ctx.model?.provider, partner);
      if (!target) return;
      routerSwitching = true;
      let ok = false;
      try {
        ok = await pi.setModel(target);
      } finally {
        routerSwitching = false;
        lastRouterSwitchAt = Date.now();
      }
      appendLog({
        ts: new Date().toISOString(), type: "failover", from: cur, to: partner,
        decision: ok ? "switched" : "switch_failed", reason: "message_end_error",
        crossTier, errorKind: ef?.kind ?? null, requeue: null, gear,
      });
      // P2-2 同回合重发：轮转成功且为模型级限流错误时，steer 重发原 prompt（每回合至多 1 次）
      // 注：实测 pi 对 429 类首包错误不自动重试（6004 有 25s 退避重试），回合内切换否则救不了当前回合
      if (ok && ef && !requeuedThisTurn && lastPrompt && Date.now() - lastPromptAt < 120_000 && Date.now() - lastRequeueAt > 60_000) {
        requeuedThisTurn = true;
        lastRequeueAt = Date.now();
        pendingRequeue = true; // P2-4 后半：回合级 outcome 据此标 neededRequeue
        try {
          await pi.sendUserMessage(lastPrompt, { deliverAs: "steer" });
          appendLog({
            ts: new Date().toISOString(), type: "failover", from: cur, to: partner,
            decision: "requeued", reason: "steer_replay", errorKind: ef.kind, gear,
          });
        } catch (e) {
          appendLog({ ts: new Date().toISOString(), stage: "requeue", err: String(e).slice(0, 300) });
        }
      }
    } catch (e) {
      appendLog({ ts: new Date().toISOString(), stage: "failover", err: String(e).slice(0, 300) });
    }
  });

  // P2-4：回合边界 outcome 采集（agent_end 携本回合 messages；错误已在 message_end 累计）
  pi.on("agent_end", () => {
    // Phase 3 ①：升级窗口仅限本回合——跨回合计数会把新回合的偶发失败误判为「连续」
    toolFailStreak = 0;
    upgradedThisTurn = false;
    outcomes.turns += 1;
    if (lastTurnHadError) outcomes.retriedTurns += 1;
    // P2-4 后半：回合级 outcome 落盘（校准分类器的数据基础；用 decisionId 关联决策记录）
    if (pendingDecisionId) {
      outcomes.laneCount.general += 0; // 保持原语义（泳道计数在 classify 侧）
      appendOutcome({
        ts: new Date().toISOString(),
        type: "turn_outcome",
        decisionId: pendingDecisionId,
        model: pendingDecisionModel,
        tier: pendingDecisionTier,
        turnResult: lastTurnHadError ? "error" : "ok",
        errorKind: lastTurnModelErrKind,
        neededRequeue: pendingRequeue,
        latencyMs: pendingDecisionAt ? Date.now() - pendingDecisionAt : null,
        gear,
      });
    }
    lastTurnHadError = false;
    lastTurnModelErrKind = null;
    pendingDecisionId = null;
    pendingDecisionAt = 0;
    pendingDecisionModel = null;
    pendingDecisionTier = null;
    pendingRequeue = false;
  });
  pi.on("agent_settled", () => {
    lastTurnHadError = false;
    lastTurnModelErrKind = null;
  });

  // P2-4：/router stats 子命令实现

  // 版本自描述：运行时读包 manifest（真源 package.json 的 version），失败回退 unknown
  const pkgVersion = (): string => {
    try {
      const p = fileURLToPath(new URL("../package.json", import.meta.url));
      return String(JSON.parse(readFileSync(p, "utf8")).version ?? "unknown");
    } catch {
      return "unknown";
    }
  };

  // /router —— 挡位与模式管理
  pi.registerCommand("router", {
    description: "Model Router 挡位管理：status | auto | manual [model] | shadow | active | stats | version",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
      let msg: string;

      if (sub === "auto") {
        gear = "auto";
        manualModel = null;
        logGear("router_command", { via: "/router auto" });
        msg = "✓ 挡位 → **自动挡**：router 按 分档→时段→健康闸 决策切换";
      } else if (sub === "manual") {
        const want = parts[1];
        if (!want) {
          gear = "manual";
          manualModel = cur;
          logGear("router_command", { via: "/router manual", model: cur });
          msg = `✓ 挡位 → **手动挡**，锁定当前模型 ${cur}（router 不再干预）`;
        } else {
          const m =
            ctx.modelRegistry.getAll().find((x) => `${x.provider}/${x.id}` === want) ??
            ctx.modelRegistry.getAll().find((x) => x.id === want);
          if (!m) {
            msg = `✗ 未找到模型：${want}（可用格式 provider/modelId）`;
          } else {
            const ok = await pi.setModel(m); // 非 router 切换 → 自然进手动挡（model_select 兜底 + 此处显式设置）
            if (ok) {
              gear = "manual";
              manualModel = `${m.provider}/${m.id}`;
              logGear("router_command", { via: "/router manual", model: manualModel });
              msg = `✓ 挡位 → **手动挡**，强制使用 ${manualModel}`;
            } else {
              msg = `✗ setModel 失败（provider 鉴权未配置？）：${m.provider}/${m.id}`;
            }
          }
        }
      } else if (sub === "stats") {
        msg = statsMessage(cfg);
      } else if (sub === "version") {
        msg = `model-router v${pkgVersion()}`;
      } else if (sub === "shadow") {
        cfg = { ...cfg, mode: "shadow" };
        logGear("router_command", { via: "/router shadow" });
        msg = "✓ 模式 → shadow（只记录不切换；持久化需改 model-router.config.json）";
      } else if (sub === "active") {
        cfg = { ...cfg, mode: "active" };
        logGear("router_command", { via: "/router active" });
        msg = "✓ 模式 → active（自动挡真实切换）";
      } else {
        const cooling = [...failState.entries()]
          .filter(([, u]) => u > Date.now())
          .map(([k, u]) => `${k}(至 ${new Date(u).toISOString().slice(11, 19)}Z)`)
          .join(", ");
        const errCooling = [...errState.entries()]
          .filter(([, w]) => w.until > Date.now())
          .map(([k, w]) => `${k}[${w.reason}](至 ${new Date(w.until).toISOString().slice(11, 19)}Z)`)
          .join(", ");
        msg = [
          `Model Router — 挡位: ${gear}${manualModel ? `（锁定 ${manualModel}）` : ""} | 模式: ${cfg.mode}`,
          `当前模型: ${cur} | 段: #${segmentSeq}(${segmentReason})`,
          `候选池: Fast[${cfg.pool.Fast.length}] Balanced[${cfg.pool.Balanced.length}] Performance[${cfg.pool.Performance.length}]`,
          `failover/轮转: 首选 ${cfg.failover.primary} / 备选 ${cfg.failover.fallback}（池序后继兑底）${cooling ? ` | 冷却中: ${cooling}` : ""}`,
          `错误反馈(P2-1): ${errCooling || "无"}`,
          `outcome(P2-4): 回合 ${outcomes.turns} | 错误回合 ${outcomes.retriedTurns} | 模型级限流 ${outcomes.modelErrors} | 泳道 code/knowledge/general ${outcomes.laneCount.code}/${outcomes.laneCount.knowledge}/${outcomes.laneCount.general}`,
          `用法: /router auto | /router manual [modelId] | /router shadow | /router active | /router stats | /router version（v${pkgVersion()}）`,
          `（决策明细: ${LOG_PATH}；回合 outcome: ${OUTCOME_LOG_PATH}）`,
        ].join("\n");
      }

      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      else process.stderr.write(`[router] ${msg}\n`);
    },
  });
}
