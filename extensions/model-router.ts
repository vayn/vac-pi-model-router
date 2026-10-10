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
 * 执行期深化（Phase 3 & 4）：
 *   · mid-thread 升档——回合内连续工具失败 ≥ midThread.failThreshold ⇒ 任务实为 hard
 *     （起点分类误判），升 1 级（每回合至多 1 次 + 冷却）；成功即归零（连续性才是难度信号）
 *   · 尝试预算——连续失败 ≥ attemptBudget.giveUpAfter ⇒ 承认卡住：记录 + 提示 + **结束本回合**
 *     交还人（ask-for-help）。与升档共用同一信号、同一 handler，按序执行：先升档，升不动才判弃
 *   · 思考等级＝**两轴取较严者**（v0.16.0 起）：档位轴 thinkingTier.byTier（Fast=minimal/
 *     Balanced=medium/Performance=high，现降为**上限**）× 成本轴 thinkingCost（免费封顶 minimal、
 *     收费 off，无例外）；**成本轴需有成本数据才生效**（v0.16.1：显式清单非空或定价表可读，
 *     否则退回档位轴——无数据≠全收费）。施加于本扩展自切模型后，以及 session_start /
 *     model_select（即“默认”语义覆盖起手与手动选定）；手动 /thinking 与
 *     settings.modelThinkingLevels 显式配置优先，不覆盖用户意图
 *   · 子代理自动分档——subagent 工具按 task 文本独立分档，注入该档锚位
 *     （显式 model 不覆盖；workflow/chain 多子代理不强插）
 *   · 同回合重发——模型级限流且轮转成功后，重放原 prompt（每回合至多 1 次 + 节流）
 *   · 时段闸唯一时相——candidatesFor() 是唯一过滤点，anchorFor() 供升档/子代理取「当前可用锚位」，
 *     故白天升档不会拿到夜间限免模型（那是「升级救命却升到一个用不了的模型」）
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
import { dirname, join } from "node:path";
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
// 健康探测用的网关鉴权配置（JSON 含 api_key）——经环境变量注入，代码不内置任何本机路径。
const GATEWAY_CONFIG = process.env.MODEL_ROUTER_GATEWAY_CONFIG ?? "";
// 定价表缓存 TTL（免费判定）；数据源变化时另有指纹分键立即失效，故此值只兜「文件内容变更」。
// 注：路径常量一律在函数体内读 process.env——模块级常量的可见性在扩展加载后不保证
//（实测 before_agent_start 报 ReferenceError），故此处只放纯数值常量。
const PRICING_TTL_MS = 5 * 60 * 1000;

/**
 * 思考等级枚举（本地声明；pi 未从包根导出该类型，故同形声明一份）。
 * 上游权威：`@earendil-works/pi-agent-core` 的 `ThinkingLevel`
 *   = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
 * （枚举扩展时两处均需改；扩展无编译期检查，只能靠运行时暴露。）
 */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 严→宽排序（off 最严 = 不推理）。用于两轴「取较严者」。 */
const THINK_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 取较严者：不在排序内的值一律当作「更宽」处理（宁可因未知值而少改动，不可误抬）。 */
function stricterLevel(a: ThinkingLevel, b: ThinkingLevel): ThinkingLevel {
  const ia = THINK_ORDER.indexOf(a);
  const ib = THINK_ORDER.indexOf(b);
  if (ia < 0) return b;
  if (ib < 0) return a;
  return ia <= ib ? a : b;
}



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
  // 免费优先数据源：定价表 rate=0 ∪ 显式清单；留空即不启用，退化为池内原序。
  pricing: {
    file: "",
    freeModels: [] as string[],
  },
  channels: ["your-provider"],
  // 决策时 ctx.model 尚未设置（会话首轮）用的 provider 兜底；空串 ⇒ 交给 resolveModel 走全注册表兜底。
  defaultProvider: "",
  promptPreviewChars: 300,
  // failover 名义对（仅作 /router status 展示语义，实际轮转按「池序后继」执行）
  // v0.8.0：primary 跟随 Balanced 池锚位改为同模型免费渠道（实际轮转以池序为准，
  //         primary/fallback 仅作 /router status 展示语义，保持与池序一致避免误读）
  failover: {
    enabled: true,
    primary: "your-provider/balanced-model",
    fallback: "your-provider/balanced-backup",
    cooldownSec: 300, // 模型失败后冷却时长（防双模型循环）
  },
  // P2-3 泳道偏好：档内新选模型时优先可行候选（in_tier_hold 优先级更高；general 不偏好）
  // v0.8.0：code 泳道同步优先免费渠道（同模型，能力位不变）；被限流时由可行过滤自然回落付费侧
  lanePref: {
    code: [],
    knowledge: [],
  },
  // P2-1 错误反馈：模型级限流短窗冷却（/status 健康闸盲区补偿）；6004 解析文案中的重置时刻
  // Phase 3 深化（v0.11.0）：
  // ① mid-thread 升档——回合内连续工具失败 ≥ 阈值 ⇒ 任务实为 hard/agentic（起点分类误判），升 1 级
  midThread: { enabled: true, failThreshold: 3, cooldownSec: 60 },
  // ② 子代理自动分档——subagent 工具按 task 文本独立分档注入 model（显式 model 不覆盖）
  subagentTier: { enabled: true },
  // Phase 4（v0.13.0）：与 midThread 互补的第二层「卡住」处理：
  // ③ 尝试预算（ask-for-help 语义）——两层语义正交，不重叠：
  //    · midThread（阈值 3）= 升档重试（换更强的模型，仍在**同一会话内继续**）
  //    · attemptBudget（阈值 5）= 放弃（已升过档 / 已到顶档仍连败 ⇒ **停止本回合**并提示用户）
  //    即先「换个模型再试」，再「承认卡住、交还人」。阈值必须**大于** midThread 才成阶梯。
  //    graceAfterUpgradeSec：刚升过档不立即判弃——否则新模型根本没机会证明自己，
  //    等于把「升档重试」和「放弃」压成同一个动作。
  attemptBudget: { enabled: true, giveUpAfter: 5, notify: true, stopTurn: true, graceAfterUpgradeSec: 30 },
  // ④ 档位→思考等级映射（v0.13.0）：简单活少想、难活多想。
  //    v0.16.0 起本块**降为上限**，与成本轴取较严者（见 ④b）；施加面亦从「仅自切」扩到
  //    session_start + model_select。不劫持用户手动 /thinking；当 settings.modelThinkingLevels
  //    对目标模型有显式配置时让位于该配置（用户显式意图优先）。
  //    未支持 reasoning 的模型由 pi 自行 clamp，无需本扩展判断。
  thinkingTier: {
    enabled: true,
    // 键为 Tier 名；用 Record<string,…> 而非 Record<Tier,…>——Tier 由 `keyof typeof DEFAULTS.pool`
    // 定义，在 DEFAULTS 字面量内引用会构成循环定义。
    byTier: { Fast: "minimal", Balanced: "medium", Performance: "high" } as Record<
      string,
      ThinkingLevel
    >,
  },
  // ④b 成本轴→思考等级（v0.16.0）：免费模型思考等级**封顶** freeMax，收费模型**默认关闭**推理 paid
  //   （旗舰无例外——高档位不代表必须深思考，收费侧一律从省 token 出发）。
  //   【与档位轴的关系】取较严者（min by THINK_ORDER），故本规则天然覆盖 ④ 的档位语义：
  //     收费 Balanced(min(medium,off)=off) / 收费 Performance(min(high,off)=off) /
  //     免费 Fast(min(minimal,minimal)=minimal) / 免费 Balanced(min(medium,minimal)=minimal)。
  //     为何不删 byTier：删了以后想放开付费推理就得重写映射；留着只调本块即可（单一真相 + 可回退）。
  //   【免费判定源】freeSet＝定价表 rate=0 ∪ 显式免费清单——与成本护栏 isPaid 同一真相，
  //     不另立第二套「免费」定义（DRY）。查不到条目 ⇒ 按收费处理（保守：宁可不给推理也不误烧钱）。
  //   【生效前置（v0.16.1）】**须有成本数据**（costDataAvailable）：显式清单非空，或定价表可读可解析。
  //     无数据 ⇒ 成本轴不生效、退回档位轴。理由：把「判不出」当「全收费」，会让未配成本源的部署
  //     （如本扩展的默认配置：pricing.file 空、无环境变量）全体等级被静默置 off——那是配置缺失，
  //     不是任何人的裁定。这也是**默认配置开箱可用**的前提：没配定价表时行为等同 v0.13.0。
  //   【回退面】enabled=false ⇒ 完全退回 v0.13.0 纯档位行为（不改代码即可回滚）。
  thinkingCost: {
    enabled: true,
    freeMax: "minimal" as ThinkingLevel,
    paid: "off" as ThinkingLevel,
  },
  // ⑤ 成本护栏（v0.14.0）——自动挡切到收费模型前的「免费优先 + 升档确认」两道闸：
  //   【规则一：同档有可用免费候选就别切收费】当真要切到的目标模型收费、而**同档内存在可用
  //     免费模型**时：只有极短 prompt（≤ shortPromptChars）才放行，否则**改为切到那个免费模型**
  //     （留在同档）。第一性原理：档位已由分类器定好，档内选谁不影响能力上限判定；免费候选已在
  //     池中且健康，那么「多花倍率买同一个档位」就是纯粹支出，没有任何能力对价。极短 prompt
  //     例外是因为它的绝对成本可忽略，而免费模型的冷启动/限流延迟往往大于省下的那点钱。
  //   【规则二：升到需确认档且本档无免费候选 ⇒ 弹窗】确认档由 confirmUpgradeTiers 指定。
  //     无法征得同意（无 UI / 超时 / 用户拒绝）⇒ **不升级、留在原档**（不擅自消耗积分）。
  //   【为何只在路由器自己切模型时生效】用户手动 /model 锁定的模型由用户负责，本扩展不拦
  //     （不劫持用户意志）。
  costGuard: {
    enabled: true,
    shortPromptChars: 200, // “极短 prompt”上限（按自有历史分布取小比例侧；可按需调）
    // 哪些档位在「升过去且需付费」时必须先问（数组 ⇒ 可自行增删确认档）
    confirmUpgradeTiers: ["Performance"] as string[],
    confirmTimeoutSec: 120, // 弹窗超时 ⇒ 按拒绝处理（安全默认）
  },
  errorFeedback: {
    enabled: true,
    rateLimitCooldownSec: 180,
    usageWindowMaxSec: 12 * 3600,
    unavailableCooldownSec: 600, // 上游模型不可用（Model is unavailable 等）短冷却，仅护轮转与 requeue
    // Phase 3（v0.10.0）：近期错误反馈感知——冷却态之外的「频次」维度
    // 动因：error-state 只存**当前窗口**（过期的记录被 loadErrorState 丢弃），
    //   故模型反复限流、每次窗口短、窗口间隙又可选 ⇒ 健康闸完全看不见。
    //   实测佐证：某模型限流记录已过期 2.3h，count 仍是 1 —— 仅凭冷却态无法反映历史频次。
    recentErrorWindowSec: 3600, // 统计窗口（默认近 1 小时）
    recentErrorMinSamples: 3,   // 窗口内至少 N 个样本才启用降权（防小样本噪声）
    recentErrorRateThreshold: 0.34, // 错误率超此值 ⇒ 该模型近期不健康
  },
  // 渠道级熔断（v0.15.0）：滑窗内同渠道失败达阈值 ⇒ 冷却整渠道。
  // 【动因】模型级冷却（`failover.cooldownSec`）只冷却**被点名的单个模型**；渠道上游整体
  //   故障时，池内同渠道的另一模型仍可被选中 ⇒ 轮转回去必再吃同一超时，表现为「连续多次
  //   截断」。实测某渠道全 4 模型均 60s 后 HTTP502 `unexpected EOF`（而 /status 健康闸只
  //   看**账号**级 available，看不见渠道整体挂，仍报 ok）。
  // 【边界】熔断需真实失败**累计**达阈值才触发，故它把「多次超时串联」压成「首次触发后
  //   同渠道全剔除」，**无法让第一个故障请求变快**。
  channelBreaker: {
    enabled: true,
    windowSec: 900, // 统计最近 15 分钟内的渠道失败次数
    failThreshold: 3, // 同渠道累计失败 3 次 ⇒ 熔断
    cooldownSec: 900, // 熔断持续 15 分钟（长于模型级冷却，覆盖渠道恢复所需时间）
  },
  // 人工禁用（“灰色”不可选）：把临时不可用的模型从候选链剔除，但**不改池构成**，
  //   `/router status` 与池内顺序仍可见 —— 适用于额度耗尽/限流（临时态，预计自行恢复）。
  //   与「移出池 + 排除表」的区别：后者用于**永久**不可用（provider 下架）。
  //   与「渠道熔断」的区别：灰色是**人工**判定（需人来判断是否恢复），熔断是**自动**自愈。
  //
  // 【外置单真源】灰名单由本文件的外置 JSON 文件承载（默认同目录 `disabled-models.json`），
  //   因为消费方不止本扩展——若你的部署还有前端/巡检脚本要读同一份名单，内联数组它们够不到，
  //   删除线之类的外围标识就只能另维一份清单 = 真源分裂。
  //   `disabledModels` 仅作 **fixture / 无该 JSON 文件时的回退值**。
  disabledModels: [] as string[],
  // 灰名单文件路径（相对本扩展目录）。存在则优先于上面的内联数组。
  disabledModelsFile: "disabled-models.json",
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
  merged.pricing = { ...DEFAULTS.pricing, ...(user.pricing ?? {}) } as Cfg["pricing"];
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

// ---------- 规则分层分类器（v1：饱和归一化；校准真源 = router_calibrate.py 的 outcome） ----------
//
// v0 → v1 的变更依据（对标 bifrost plugins/routing/complexity 的成熟形态）：
//   ① 裸计数改饱和计数：同一信号出现 N 次不代表难度翻 N 倍（实测旧 score 跨 -4~15，无界）。
//   ② score 归一化到 [0,1]（可含负），阈值改相对值 → 可跨语料比较、可被 outcome 校准。
//   ③ 保留 v0 的分档决策边界语义（见 classify 内注释），使新旧档位分布可比。
// 不照搬项：system prompt 软贡献 / 多轮上下文 blending —— 那需要网关位置的 body 访问权，
// pi 扩展只有单条 prompt 文本，抄了也无法实现（KISS）。

const HARD = /架构|根因|深入|调研|权衡|性能|排查|迁移|系统性|容量|并发|安全|设计(方案|评审)|基准|A\/B|benchmark|architecture|root cause|investigat|trade-?off|deep dive/gi;
const AGENTIC = /修复|实现|重构|部署|提交|调试|改(造|写)|编写|集成|回滚|排查(不了)?|fix|implement|refactor|debug|deploy|migrat(?!ion)|测试用例|写(个|一个)(脚本|工具)|删除(文件|目录)/gi;
const EASY = /是什么|什么是|列(出|一下)|翻译|格式化|重命名|总结|摘要|查一下|解释(一下)?|快速|多少钱|几点|what is|define|quickly|tl;?dr/gi;

// 饱和点 k：命中该次数即视为该维度信号过半（n/(n+k)=0.5）。HARD 收得最紧（2）——
// 它是唯一能直推 Performance 的信号，最需抗刷分。
const SAT_HARD = 1, SAT_AGENTIC = 3, SAT_EASY = 2;
// 维度权重（正向合计 1.00；EASY 为惩罚项，刻意不计入该预算）。
const W_HARD = 0.6, W_AGENTIC = 0.4, W_EASY = 0.20;
// 长度带/codeBlock 作为**弱**证据并入 agentic 维度（长 prompt 本身不构成难度）。
const LENGTH_BAND_MAX = 0.5;
/** 分类器版本标识：写入每条决策日志，供 outcome 校准按版本分组（禁跨版本混算）。 */
export const CLASSIFIER_VERSION = "v1-saturating";

// 归一化阈值（v0 决策边界的等价换算：旧 score>=3 ≈ 0.5；>=1 ≈ 0.25）。
const TH_PERF = 0.40, TH_BALANCED = 0.15, TH_FAST_MIN = -0.20;
const TH_CONF_HIGH_PERF = 0.45, TH_CONF_HIGH_FAST = -0.15;

/** 饱和计数：n 次命中 → n/(n+k)（n=0 为 0，k 次为 0.5，趋近 1）。 */
function sat(n: number, k: number): number {
  return n / (n + k);
}
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

  // 饱和归一化：每维度先 n/(n+k) 再按权重合成（线性，无隐藏耦合）。
  const sh = sat(hard, SAT_HARD);
  const sa = sat(agentic, SAT_AGENTIC);
  const se = sat(easy, SAT_EASY);
  // codeBlock 与长度带是弱证据（各自 ≤ LENGTH_BAND_MAX），并入 agentic 维度
  const agenticBoost = Math.min(
    1,
    sa + (codeBlock ? LENGTH_BAND_MAX : 0) + (lengthBand / 2) * LENGTH_BAND_MAX,
  );
  const score = W_HARD * sh + W_AGENTIC * agenticBoost - W_EASY * se;

  // 保守优先：歧义一律 Balanced（避免 fast-only 失败模式）
  let tier: Tier = "Balanced";
  let rule = "default_balanced";
  if (hard >= 1 && score >= TH_PERF) {
    tier = "Performance";
    rule = "perf_hard";
  } else if (easy >= 1 && agentic === 0 && hard === 0 && chars < 600) {
    tier = "Fast";
    rule = "fast_easy";
  } else if (score >= TH_BALANCED) {
    tier = "Balanced";
    rule = "balanced_score";
  }
  const confidence =
    (tier === "Performance" && score >= TH_CONF_HIGH_PERF) ||
    (tier === "Fast" && score <= TH_CONF_HIGH_FAST)
      ? "high"
      : "low";

  // classified=false 表示本条 prompt 未命中任何信号 → 档位来自保守兜底而非判定（
  // 对标 bifrost 的「无信号 → unknown → 保持原路径，不猜」；此处不拒绝路由，只做标注，
  // 使 decision-log 能区分「判定为 Balanced」与「无信号兜底 Balanced」）。
  const classified = hard > 0 || agentic > 0 || easy > 0 || codeBlock || lengthBand > 0;

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
    classified,
    // 分数构成：归一化分量（供 outcome 校准定位是哪一维在驱动档位）
    scoreBreakdown: { hard: sh, agentic: agenticBoost, easy: se },
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

// 模型解析：优先按 provider 精确查；未命中则回退全注册表按 `provider/model` 或裸 id 匹配。
// 必要性：池项均为 `<channel>/<model>` 形态，而 find(provider, id) 要求 provider 精确相等——
// 会话若处在非池 provider（如手动挡锁到他人 provider），原先所有切换都会静默 miss
// （before_agent_start 落 model_not_found，另两处直接 return），路由事实上瘫痪。
// 兜底后：单 provider 网关布局行为不变，多 provider 布局亦可路由。
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

// 缓存按「数据源指纹」分键：配置或文件变化时立即失效，避免 5 分钟 TTL 内沿用旧判定
// （例如定价表被删除后若仍用缓存，会把已转付费的模型继续当免费）。
// 【available（v0.16.1）】区分两件常被混淆的事：
//   · 「判为收费」＝**有**成本数据、但该模型不在其中 ⇒ 保守按收费（花钱侧不冒险）；
//   · 「判不出」＝**无**成本数据（未配显式清单、定价表未配或不可读）⇒ 无从判断。
//     若把后者当「全收费」，则未配成本源的部署会被静默把全体思考等级置 off——那是配置缺失，
//     不是任何人的裁定。故思考等级的成本轴只在 available 时生效（见 desiredThinkingLevel）。
let pricingCache: { key: string; at: number; free: Set<string>; available: boolean } | null = null;

/** 成本知识：免费集合 + 是否有成本数据。两者必须同源同缓存（否则可能取自不同快照）。 */
function costKnowledge(c: Cfg): { free: Set<string>; available: boolean } {
  // ① 显式清单（无定价表部署的主要形式）
  const list = c.pricing?.freeModels ?? [];

  // ② 定价表（rate=0 ⇒ 免费）；环境变量优先级高于配置文件路径
  const file = process.env.MODEL_ROUTER_PRICING || c.pricing?.file || "";

  const key = JSON.stringify([list, file]);
  const now = Date.now();
  if (pricingCache && pricingCache.key === key && now - pricingCache.at < PRICING_TTL_MS) {
    return pricingCache;
  }
  const free = new Set<string>();
  for (const m of list) if (typeof m === "string" && m) free.add(m);
  // 「有成本数据」＝显式清单非空，**或**定价表可读且可解析（读到表即可，哪怕零条免费也是数据）
  let available = free.size > 0;

  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const rows: unknown[] = Array.isArray(raw) ? raw : (raw?.models ?? []);
      for (const r of rows) {
        const row = r as { model?: unknown; channel?: unknown; rate?: unknown };
        if (typeof row.model !== "string") continue;
        if (row.rate === 0) free.add(`${String(row.channel ?? "")}/${row.model}`);
      }
      available = true;
    } catch {
      /* 读失败 ⇒ available 取决于显式清单；绝不阻断会话 */
    }
  }

  pricingCache = { key, at: now, free, available };
  return pricingCache;
}

/** 免费模型集合 ＝ 定价表（rate=0）∪ 显式免费清单。数据源缺失 ⇒ 空集 ⇒ 上层返回原序。 */
function freeSet(c: Cfg): Set<string> {
  return costKnowledge(c).free;
}

/** 是否**有**成本数据可判（v0.16.1）：显式清单非空，或定价表可读且可解析。 */
function costDataAvailable(c: Cfg): boolean {
  return costKnowledge(c).available;
}

function freeFirst(models: string[], c: Cfg): string[] {
  const free = freeSet(c);
  if (free.size === 0) return models; // 判不出免费 ⇒ 保持池内原序（fail-open）
  const head = models.filter((m) => free.has(m));
  const tail = models.filter((m) => !free.has(m));
  return [...head, ...tail];
}
function channelOf(modelId: string) {
  return modelId.split("/")[0] ?? "";
}

// ---------- 人工禁用（“灰色”不可选）----------

/** 灰名单文件绝对路径（供 /router grey* 展示与外部脚本提示）。 */
function disabledModelsPath(c: Cfg): string {
  const rel = c.disabledModelsFile || "disabled-models.json";
  return (
    process.env.MODEL_ROUTER_DISABLED_MODELS ||
    fileURLToPath(new URL(`../${rel}`, import.meta.url))
  );
}

/** 灰名单完整条目（含 reason/reviewAt），供展示用；解析失败退化为裸 id 列表。 */
function disabledEntries(c: Cfg): Array<{ id: string; reason?: string; reviewAt?: string | null }> {
  try {
    const doc = JSON.parse(readFileSync(disabledModelsPath(c), "utf8")) as {
      models?: Array<{ id?: string; reason?: string; reviewAt?: string | null } | string>;
    };
    return (doc.models ?? [])
      .map((m) => (typeof m === "string" ? { id: m } : { id: m?.id ?? "", reason: m?.reason, reviewAt: m?.reviewAt }))
      .filter((e) => e.id.length > 0);
  } catch {
    return disabledList(c).map((id) => ({ id }));
  }
}

/** 灰名单单真源（外置文件）——带 mtime 缓存。
 *  为何缓存按 mtime 而非 TTL：灰名单是**人工编辑**的文件，改完即期望立即生效；
 *  TTL 会在窗口内沿用旧值（同定价缓存按指纹分键的设计动机）。
 *  读不到文件 ⇒ 回退 DEFAULTS.disabledModels（无该文件时靠内联数组）。 */
let disabledCache: { mtimeMs: number; list: string[] } | null = null;

function disabledList(c: Cfg): string[] {
  const p = disabledModelsPath(c);
  try {
    const st = statSync(p);
    if (disabledCache && disabledCache.mtimeMs === st.mtimeMs) return disabledCache.list;
    const doc = JSON.parse(readFileSync(p, "utf8")) as { models?: Array<{ id?: string } | string> };
    const list = (doc.models ?? [])
      .map((m) => (typeof m === "string" ? m : (m?.id ?? "")))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    disabledCache = { mtimeMs: st.mtimeMs, list };
    return list;
  } catch {
    return c.disabledModels ?? []; // 文件缺失/非法 ⇒ 回退内联数组（fail-safe）
  }
}

/** 人工禁用（灰色）判定：精确匹配或 `"<渠道>/*"` 通配。
 *  注意 slice(0,-2) 去掉末尾的 `"/*"`（仅去 `*` 会残留 `/` 导致永不匹配）。 */
function isDisabled(modelId: string, c: Cfg): boolean {
  const list = disabledList(c);
  if (list.length === 0) return false;
  const ch = channelOf(modelId);
  return list.some((p) => p === modelId || (p.endsWith("/*") && p.slice(0, -2) === ch));
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
//   正合 Phase 3「近期错误反馈感知」原意；新增状态文件只会造成又一处待同步的真相。
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
  //   v0.10.1 修复：原正则只匹配中文形态，英文 6004（实弹撞窗）漏判 ⇒
  //   冷却窗丢失，同模型在重置前被反复尝试（每次撞窗 = 浪费一回合）。
  const m6004 = text.match(/(使用量|用量|usage\s+exceeds?\s+frequency|usage\s+limit).*?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
  if (m6004) {
    const reset = Date.parse(m6004[2].replace(" ", "T"));
    let until = Number.isNaN(reset) ? 0 : reset;
    // 网关报 UTC+8 时刻；Date.parse 无时区后缀按本地时区解析，本地非 UTC+8 时需自行换算。
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

const outcomes = { turns: 0, errors: 0, modelErrors: 0, retriedTurns: 0, laneCount: { code: 0, knowledge: 0, general: 0 }, midThreadUpgrades: 0, subagentTiered: 0, attemptsGaveUp: 0, thinkingApplied: 0, costGuardRedirected: 0, costGuardConfirmed: 0, costGuardDeclined: 0 };
let lastTurnHadError = false;
let lastTurnModelErrKind: string | null = null;
// Phase 3：mid-thread 升档状态（回合内连续工具失败计数；agent_end 归零）
let toolFailStreak = 0;
let upgradedThisTurn = false;
let lastUpgradeAt = 0; // 升档冷却独立计时——不能复用 lastRouterSwitchAt（开局 setModel 也刷新它，会把首回合升级永久压制）
// Phase 4：尝试预算（ask-for-help）——回合内只放弃一次（防重复 abort）
let gaveUpThisTurn = false;

// ---------- P2-4 后半：回合级 outcome 落盘（校准分类器的数据基础） ----------
// 【动因】原 outcomes 仅**进程内计数**（/router stats），进程退出即失；且决策日志无 outcome 字段
//   ⇒ 无法回答「某档/某模型实际成功率多少」，分类器只能纯规则打分 自述「校准未完成期」）。
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
  // 时段闸在此**唯一**生效：限免/限时模型白天从候选剔除、夜间恢复。
  // 放在这里（而非只放 decide()）是因为 mid-thread 升档与子代理分档都直接取候选首位——
  // 若只在 decide() 过滤，那两条路径白天会拿到夜间限免模型，升档即撞限流（升到一个用不了的模型）。
  // Performance 池被剔空 → 调用方自然级联降档 Balanced（级联兜底，无需在此特判）。
  const usable = c.pool[tier].filter((m) => !(m === c.timeGate.model && !night));
  // 人工禁用（灰色）在此过滤：本函数是 decide 主链 / mid-thread 升档 / 子代理分档的
  // **唯一候选真相源**——只在一个地方消费，旁路就仍会选中灰模型。
  const enabled = usable.filter((m) => !isDisabled(m, c));
  // Free models first within a tier; order within each group is preserved.
  return freeFirst(enabled, c);
}

/** 沿降档链取首个非空锚位——升档/子代理注入的唯一取模入口（保证拿到的是当前时段可用者）。 */
function anchorFor(tier: Tier, night: boolean, c: Cfg): { model: string; tier: Tier } | null {
  const start = TIER_DESCENT.indexOf(tier);
  for (let i = start; i < TIER_DESCENT.length; i++) {
    const t = TIER_DESCENT[i];
    const m = candidatesFor(t, night, c)[0];
    if (m) return { model: m, tier: t };
  }
  return null;
}

// ---------- 成本护栏（v0.14.0） ----------
// 两条规则共用同一套「付费/免费」判定，故集中在此，供主路径与升档路径共用（单一真相）。

/** 目标模型是否收费。判定源＝与 freeFirst 同一个 freeSet（定价表 rate=0 ∪ 显式清单）。
 *  查不到条目 ⇒ 按收费处理（与 freeSet 注释同一套保守口径，不误放行）。 */
function isPaid(modelId: string, c: Cfg): boolean {
  return !freeSet(c).has(modelId);
}

/** 同档内可用的免费候选（受时段 gate + 健康/冷却过滤后的真实可用集，非池裸集）。
 *  为何要过滤而不是直接看池：若同档免费候选正处冷却/渠道不健康，它就不是「可用替代」，
 *  此时不应因它存在而把决策逼向免费模型（否则从「可用付费」退化成「不可用免费」）。 */
function freeCandidateInTier(tier: Tier, night: boolean, c: Cfg, health: HealthResult): string | null {
  const free = freeSet(c);
  if (free.size === 0) return null;
  for (const m of candidatesFor(tier, night, c)) {
    if (!free.has(m)) continue;
    if (health.status === "ok" && health.channels[channelOf(m)] === false) continue;
    // 渠道级熔断：熔断中渠道的模型不算「可用免费候选」，
    //   否则会把决策从「可用付费」退化成「不可用免费」。
    if (isChannelTripped(channelOf(m), c)) continue;
    if (isCooling(m) || isErrorCooling(m)) continue;
    return m;
  }
  return null;
}

/** 规则一的决策纯函数（无副作用，便于单测）：给定「本来要切到的付费模型」，
 *  返回应当改切的目标（免费候选）或 null（放行付费）。
 *  · 非付费目标 → null（无需干预）；
 *  · 无同档可用免费候选 → null（规则一不适用，交给规则二/其他路径）；
 *  · prompt 极短 → null（例外放行）；
 *  · 其余 → 返回该免费候选。 */
function freeInsteadOfPaid(
  target: string,
  targetTier: Tier,
  promptChars: number,
  night: boolean,
  c: Cfg,
  health: HealthResult,
): string | null {
  const cg = c.costGuard;
  if (!cg?.enabled) return null;
  if (!isPaid(target, c)) return null;
  const free = freeCandidateInTier(targetTier, night, c, health);
  if (!free || free === target) return null;
  if (promptChars <= cg.shortPromptChars) return null; // 极短 prompt 例外
  return free;
}

/** 规则二：升到指定档位且目标收费时，是否必须先征得用户同意。
 *  返回 true 仅当「目标收费 ∧ 该档在 confirmUpgradeTiers 内 ∧ 该档无可用免费候选」。
 *  为何要看「无可用免费候选」：若本档有免费候选，规则一已经把它换上了，自然不需要问。 */
function needsUpgradeConfirm(
  target: string,
  targetTier: Tier,
  night: boolean,
  c: Cfg,
  health: HealthResult,
): boolean {
  const cg = c.costGuard;
  if (!cg?.enabled) return false;
  if (!(cg.confirmUpgradeTiers ?? []).includes(targetTier)) return false;
  if (!isPaid(target, c)) return false;
  return freeCandidateInTier(targetTier, night, c, health) === null;
}

/** 倍率（供弹窗展示）。【数据缺口】定价表只有相对倍率 rate（基准=1.0），
 *  没有可靠的绝对单价，故**只报倍率、不编造积分数字**（本仓纪律：无源不报）。
 *  0 = 免费；查不到条目 = null（显示为「费率未知」而非猜一个数）。 */
function rateOf(modelId: string): number | null {
  try {
    const file = process.env.MODEL_ROUTER_PRICING || cfg.pricing?.file || "";
    if (!file) return null;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const rows: Array<{ model?: unknown; channel?: unknown; rate?: unknown }> = Array.isArray(raw)
      ? raw
      : (raw?.models ?? []);
    for (const r of rows) {
      if (`${String(r.channel ?? "")}/${String(r.model ?? "")}` === modelId) {
        return typeof r.rate === "number" ? r.rate : null;
      }
    }
  } catch {
    /* 定价表不可读 ⇒ 无倍率可展示；不阻断 */
  }
  return null;
}

/** 规则二的交互面：弹窗征询；任何异常/超时/无 UI ⇒ 返回 false（＝拒绝，安全默认）。
 *  【为何无 UI 时不升级】无法征得同意就不擅自消耗积分；headless/RPC 下 hasUI=false
 *  ⇒ 直接拒绝，行为可预期且不烧钱。 */
async function confirmUpgrade(
  ctx: { hasUI?: boolean; ui?: { confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean> } },
  target: string,
  targetTier: Tier,
  fromTier: Tier | null,
  promptChars: number,
  c: Cfg,
): Promise<boolean> {
  const rate = rateOf(target);
  const rateText = rate === null ? "费率未知（定价表无条目）" : rate === 0 ? "免费" : `x${rate}（基准 = 1.0）`;
  const night = isNight(new Date().getHours(), c.timeGate);
  const freeNow = freeCandidateInTier(targetTier, night, c, { status: "unknown", channels: {} });
  const msg = [
    `目标模型  ${target}`,
    `计费倍率  ${rateText}`,
    `当前档位  ${fromTier ?? "?"} → 目标档位 ${targetTier}${freeNow ? `（本档有免费候选 ${freeNow}）` : "（本档无免费候选）"}`,
    `prompt    ${promptChars} 字符`,
    "",
    "说明：绝对积分无法折算（定价表仅提供相对倍率，无基准价）。",
  ].join("\n");
  try {
    if (!ctx?.hasUI || !ctx.ui?.confirm) return false;
    const ok = await ctx.ui.confirm(`确认升级到 ${targetTier} 档？`, msg, {
      timeout: Math.max(1, c.costGuard.confirmTimeoutSec) * 1000,
    });
    return ok === true;
  } catch {
    return false; // 弹窗失败一律按拒绝（安全侧）
  }
}

/** 子代理分档的「成本护栏版」锚位（无交互版）。
 *  【为何与主路径不同】子代理注入发生在 tool_call 内，**不能阻塞在弹窗上**：
 *    ① 会卡住工具调用；② 一个 workflow 可能多个子代理，弹窗会反复打断。
 *    故采用「无法征得同意 ⇒ 不花钱」的安全侧：需确认的档位**降一档**取锚位，而不是直接注入付费。
 *  【规则顺序】先免费替代（同档，无能力对价），再判是否需确认（降档），否则用原锚位。
 *    注意：短 prompt 例外（freeInsteadOfPaid 内部）在此不构成「绕过确认」的后门——
 *    短 prompt 只是使规则一不干预，随后规则二照样会因「无人可问」而降档。 */
function guardedAnchorFor(
  tier: Tier,
  promptChars: number,
  night: boolean,
  c: Cfg,
  health: HealthResult,
): { model: string; tier: Tier; guard: Record<string, unknown> | null } | null {
  const start = TIER_DESCENT.indexOf(tier);
  for (let i = start; i < TIER_DESCENT.length; i++) {
    const t = TIER_DESCENT[i];
    const m = candidatesFor(t, night, c)[0];
    if (!m) continue;
    const freeAlt = freeInsteadOfPaid(m, t, promptChars, night, c, health);
    if (freeAlt) {
      return {
        model: freeAlt, tier: t,
        guard: { action: "paid_to_free", from: m, to: freeAlt, tier: t, paidRate: rateOf(m), promptChars },
      };
    }
    if (needsUpgradeConfirm(m, t, night, c, health)) {
      continue; // 需确认但无人可问 ⇒ 降一档（不擅自消耗积分）
    }
    return { model: m, tier: t, guard: null };
  }
  return null;
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
    const cands = candidatesFor(t, night, c);
    lastCandidates = cands;
    const viable0 =
      health.status === "ok" ? cands.filter((m) => health.channels[channelOf(m)] !== false) : cands;
    if (viable0.length < cands.length) chain.push(`filtered_by_health:${cands.length}->${viable0.length}`);
    // 渠道级熔断：账号级健康闸（health.channels）看不见「渠道上游整体挂」——
    //   它只反映账号 available，渠道级 502/EOF 时仍可能报 ok。故在此剔除熔断中渠道的
    //   全部模型，使轮转自然落到其他渠道而非反复吃同一超时。
    //   注：健康闸已报该渠道 false 时（viable0 已剔除）无需重复过滤，避免 chain 噪声。
    const cbCfg = channelBreakerCfg(c);
    const viableCB =
      cbCfg.enabled && health.status !== "ok"
        ? viable0.filter((m) => !isChannelTripped(channelOf(m), c))
        : viable0;
    if (viableCB.length < viable0.length) chain.push(`filtered_by_channel_breaker:${viable0.length}->${viableCB.length}`);
    // failover 冷却中的模型不可选（含 in_tier_hold 的 current 自身）
    const viable1 = viableCB.filter((m) => !isCooling(m));
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

// ---------- 渠道级熔断（v0.15.0）----------
// 缺陷：模型级冷却（markFailed）只冷却**被点名的单个模型**，渠道整体挂时池内同渠道
//   另一模型仍可被选中 ⇒ 轮转回去必再吃同一超时，表现为「连续多次截断」。
// 处置：同渠道在滑窗内累计失败达阈值 ⇒ 冷却**整渠道**（含未被直接点名的同渠道模型），
//   使轮转自然落到其他渠道；渠道级熔断只护轮转，与模型级冷却互不覆盖。
const CHANNEL_BREAKER_STATE_PATH = join(STATE_DIR, "channel-breaker-state.json");

/** 渠道熔断判定配置（默认值可在 Cfg.channelBreaker 覆盖）。 */
const CHANNEL_BREAKER_DEFAULT = {
  enabled: true,
  windowSec: 900, // 滑窗：统计最近 15 分钟内的渠道失败次数
  failThreshold: 3, // 同渠道累计失败达 3 次 ⇒ 熔断整渠道
  cooldownSec: 900, // 熔断持续时长；过期自动恢复（渠道级冷却长于模型级）
};

interface ChannelBreakerCfg {
  enabled: boolean;
  windowSec: number;
  failThreshold: number;
  cooldownSec: number;
}

type FailRecord = { fails: number[]; until: number };

function loadChannelBreaker(): Map<string, FailRecord> {
  try {
    const raw = JSON.parse(readFileSync(CHANNEL_BREAKER_STATE_PATH, "utf8")) as Record<string, FailRecord>;
    const m = new Map<string, FailRecord>();
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      const fails = (v.fails ?? []).filter((t) => now - t < 24 * 3600 * 1000); // 只留 24h 内
      const until = (v.until ?? 0) > now ? v.until : 0;
      if (fails.length || until) m.set(k, { fails, until });
    }
    return m;
  } catch {
    return new Map();
  }
}

const channelState: Map<string, FailRecord> = loadChannelBreaker();

function persistChannelBreaker() {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const obj: Record<string, FailRecord> = {};
    for (const [k, v] of channelState) obj[k] = v;
    writeFileSync(CHANNEL_BREAKER_STATE_PATH, JSON.stringify(obj), { mode: 0o600 });
  } catch {
    /* 状态持久化失败不阻断 */
  }
}

function channelBreakerCfg(c: Cfg): ChannelBreakerCfg {
  return { ...CHANNEL_BREAKER_DEFAULT, ...(c.channelBreaker ?? {}) };
}

/** 渠道是否处于熔断冷却中。 */
function isChannelTripped(channel: string, c: Cfg): boolean {
  const cfg = channelBreakerCfg(c);
  if (!cfg.enabled || !channel) return false;
  const rec = channelState.get(channel);
  return !!rec && rec.until > Date.now();
}

/** 记录一次渠道失败；达阈值则熔断整渠道。返回是否本次触发了熔断。 */
function markChannelFailed(channel: string, c: Cfg): boolean {
  const cfg = channelBreakerCfg(c);
  if (!cfg.enabled || !channel) return false;
  const now = Date.now();
  const rec = channelState.get(channel) ?? { fails: [], until: 0 };
  rec.fails = rec.fails.filter((t) => now - t < cfg.windowSec * 1000);
  rec.fails.push(now);
  let tripped = false;
  // 熔断期内新增失败**不延长** until——否则持续失败会让渠道永远无法恢复自检。
  if (rec.until <= now && rec.fails.length >= cfg.failThreshold) {
    rec.until = now + cfg.cooldownSec * 1000;
    tripped = true;
  }
  channelState.set(channel, rec);
  persistChannelBreaker();
  return tripped;
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

// ── Phase 3 ①：mid-thread 升档 ──
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

// ── 尝试预算（ask-for-help）──
// 与 upgradeTierForStreak 共用同一信号（连续工具失败），但判据不同：
//   · 升档问「还能不能往上换一个」；本函数问「换了也没用，是否该停下交还人」。
//   · 阈值递增（5 > 3）保证次序：先升档重试，升不动或升完仍败才判弃。
//   · graceAfterUpgradeSec：刚升档后的冷却窗内即使 streak 已达标也先不判弃。
function attemptBudgetExhausted(c: Cfg): boolean {
  const ab = c.attemptBudget;
  if (!ab?.enabled || gaveUpThisTurn) return false;
  if (toolFailStreak < ab.giveUpAfter) return false;
  if (upgradedThisTurn && Date.now() - lastUpgradeAt < ab.graceAfterUpgradeSec * 1000) return false;
  return true;
}

// ── Phase 4（v0.13.0）→ v0.16.0：思考等级＝两轴取较严者（档位轴 × 成本轴）──
// 【施加时机】本扩展**自己切换模型**后、以及 session_start / model_select。
// 【用户显式配置优先】settings.modelThinkingLevels 对目标模型有配置 ⇒ 让位（用户显式意图 > 默认值）。
// 【不自行判断模型能力】pi 的 setThinkingLevel 已按模型能力 clamp（不支持 reasoning 的模型降到 off）。
// 【键口径】modelId 必须是**解析后模型**的 `${provider}/${id}`（即 settings.modelThinkingLevels 的键），
//   而不是池项写法 `<channel>/<model>`——二者通常不同（池项前缀是网关渠道名，
//   解析后的 provider 是 pi 的注册 provider 名）。传池项写法会**永远查不中**用户配置
//   ⇒ 静默覆盖用户显式意图。这层「用户显式配置优先」的保证即因此失效。

/**
 * 解析后 `${provider}/${id}` → 定价表/池项写法（剩掉 provider 段）。
 * 经统一网关时，网关通常把池项写法当作 model.id 下发，故剩一段即回到 `<channel>/<model>`；
 * 第三方直连模型剩出来是裸 id，定价表查不到 ⇒ 按收费处理（与 isPaid 的保守口径一致）。
 * 【为何不逐个调用点传池项写法】各调用点手边形态不一，统一从解析后形态回推可避免
 * 第四种「传错口径」。
 */
function poolIdOf(parsedId: string): string {
  const i = parsedId.indexOf("/");
  return i >= 0 ? parsedId.slice(i + 1) : parsedId;
}

/** 成本轴的免费判定：池项写法 ∪ 解析后写法，任一命中定价表即算免费。
 *  仅在**有成本数据**时调用（costDataAvailable 为真）；数据在位但查不到该模型
 *  ⇒ 按收费处理（保守：宁可不给推理，也不误烧钱）。 */
function isFreeInPricing(poolId: string, parsedId: string, c: Cfg): boolean {
  const free = freeSet(c);
  if (free.size === 0) return false;
  return free.has(poolId) || free.has(parsedId);
}

/**
 * 期望思考等级＝两轴取较严者（v0.16.0 核心规则，纯函数便于单测）。
 *  · 档位轴：byTier[tier]（v0.13.0 遗产，现为上限）；越池模型（tier=null）无档位上限。
 *  · 成本轴：免费 ⇒ freeMax（封顶）；收费 ⇒ paid（=off，无例外）。
 *  · 成本轴 disabled ⇒ 完全退回 v0.13.0 纯档位行为（回退面）。
 *  · **无成本数据 ⇒ 成本轴不生效**（v0.16.1）：显式清单空、定价表未配或不可读时
 *    无从判免费/收费 ⇒ 直接返回档位轴，而不是把「无数据」当「全收费」把等级一律压 off。
 *    「判不出」与「判为收费」必须分开：前者是配置缺失，后者才是花钱判断。
 */
function desiredThinkingLevel(parsedId: string, tier: Tier | null, c: Cfg): ThinkingLevel | null {
  const tt = c.thinkingTier;
  const tierLevel = tt?.enabled && tier ? tt.byTier?.[tier] ?? null : null;
  const tc = c.thinkingCost;
  if (!tc?.enabled) return tierLevel;
  if (!costDataAvailable(c)) return tierLevel;
  const costLevel: ThinkingLevel = isFreeInPricing(poolIdOf(parsedId), parsedId, c) ? tc.freeMax : tc.paid;
  return tierLevel ? stricterLevel(tierLevel, costLevel) : costLevel;
}

function applyThinkingTier(pi: ExtensionAPI, modelId: string, tier: Tier | null, c: Cfg): ThinkingLevel | null {
  const want = desiredThinkingLevel(modelId, tier, c);
  if (!want) return null;
  try {
    const explicit = pi.getSettings()?.modelThinkingLevels?.[modelId];
    if (explicit) return null; // 用户显式配置优先，不覆盖
    if (pi.getThinkingLevel() === want) return null;
    pi.setThinkingLevel(want);
    outcomes.thinkingApplied += 1;
    return want;
  } catch {
    return null; // 思考等级调整失败不得阻断会话
  }
}

/**
 * 「默认」语义的施加入口（v0.16.0）：对**当前已选定**的模型定一次思考等级。
 * 【为何必须】「默认关闭推理 / 免费封顶 minimal」的语义必须覆盖起手与手动选定；
 *   只在 router 自切后施加，则一天没触发切换时全天无人施加过任何等级——“默认”名不副实。
 * 【只在被选定时刻施加一次】之后不回头改——用户随后 /thinking 是运行期意志，一律保留。
 * 【幂等】同一目标等级重复调用不会写两次（getThinkingLevel()===want ⇒ 直接返回 null）。
 * 【失败不得阻断】applyThinkingTier 内部已 try/catch。
 */
function applyThinkingDefault(pi: ExtensionAPI, parsedId: string, c: Cfg, trigger: string): ThinkingLevel | null {
  const tier = tierOf(poolIdOf(parsedId), c);
  const got = applyThinkingTier(pi, parsedId, tier, c);
  if (got !== null) {
    appendLog({
      ts: new Date().toISOString(),
      type: "thinking_default",
      trigger,
      model: parsedId,
      poolModel: poolIdOf(parsedId),
      tier,
      free: isFreeInPricing(poolIdOf(parsedId), parsedId, c),
      thinkingLevel: got,
    });
  }
  return got;
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
    `Phase 4: 尝试预算 ${cfg.attemptBudget?.enabled ? `开(连败${cfg.attemptBudget.giveUpAfter}次⇒停止回合)` : "关"} | 已放弃 ${outcomes.attemptsGaveUp} | 本回合连败 ${toolFailStreak}`,
    `思考等级（v0.16.0 两轴取较严）: 已施加 ${outcomes.thinkingApplied} 次 | 成本轴 ${
      c.thinkingCost?.enabled
        ? `开（免费≤${c.thinkingCost.freeMax} / 收费=${c.thinkingCost.paid}，施加于自切+session_start+model_select；${
            costDataAvailable(c) ? "成本数据在位" : "**无成本数据⇒成本轴惰性，仅档位轴**"
          }）`
        : "关（仅档位轴 byTier）"
    }`,
    `Phase 5 成本护栏: 改走免费 ${outcomes.costGuardRedirected} 次 | 升档已确认 ${outcomes.costGuardConfirmed} 次 | 升档被拒/无UI ${outcomes.costGuardDeclined} 次`,
    `错误反馈窗（P2-1）: ${errCooling || "无"}`,
    `（跨进程持久决策明细: ${LOG_PATH}；回合 outcome: ${OUTCOME_LOG_PATH}；error-state: ${ERROR_STATE_PATH}）`,
  ].join("\n");
}

// ---------- 扩展入口 ----------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
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
    // v0.16.0：起手即按两轴定一次默认思考等级（必须在 cfg 重读之后）。
    // 注：本 hook 在 ctx.model 尚未就绪的 runtime 下会空转，由 model_select hook 补上（两者幂等）。
    if (cfg.enabled) {
      const m = ctx.model;
      if (m) applyThinkingDefault(pi, `${m.provider}/${m.id}`, cfg, `session_start:${event.reason}`);
    }
  });

  // 手动挡触发：任何非 router 的、发生在用户消息之后的模型选择
  pi.on("model_select", (event) => {
    const id = `${event.model.provider}/${event.model.id}`;
    const byRouter = routerSwitching || Date.now() - lastRouterSwitchAt < 1000; // router 自动切换
    // v0.16.0：任何模型选定都定一次默认（含起手与用户手动 /model）。
    // router 自切路径已在切后施加过，同一目标等级下本调用幂等空转（不重复写、不重复记）。
    if (cfg.enabled && !byRouter) applyThinkingDefault(pi, id, cfg, "model_select");
    if (byRouter) return;
    if (!promptedOnce) return; // 启动/新会话的初始模型选择不算强制
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
        clsVersion: CLASSIFIER_VERSION,
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
      let costGuard: Record<string, unknown> | null = null;
      let declinedUpgrade = false;

      if (dec.model === null) {
        decision = "no_viable";
      } else if (dec.model === currentId) {
        decision = "no_change";
      } else if (cfg.mode === "shadow") {
        decision = "would_switch";
      } else {
        // ── 成本护栏（v0.14.0）──
        // 此地是**所有自动切换的唯一出口**（主路径）——故两条规则都挂在这里，而不是散在
        // decide() 里（decide 是纯决策，不应做交互，也不应知道 prompt 长度这类外部变量）。
        const pChars = [...event.prompt].length;
        let wantModel = dec.model;
        let wantTier = dec.tier;
        const nightNow = isNight(hour, cfg.timeGate);

        // 规则一：有免费候选就别切收费（极短 prompt 除外）
        const freeAlt = freeInsteadOfPaid(wantModel, wantTier, pChars, nightNow, cfg, dec.health);
        if (freeAlt) {
          costGuard = {
            action: "paid_to_free", from: wantModel, to: freeAlt, tier: wantTier,
            paidRate: rateOf(wantModel), promptChars: pChars, promptIsShort: false,
          };
          outcomes.costGuardRedirected += 1;
          wantModel = freeAlt;
        } else {
          // 规则二：无可免费替代的「升档且付费」 ⇒ 弹窗；拒绝/超时/无 UI ⇒ 留在原档
          // 「升档」以**当前模型所在档**为基准（不是分类器判出的档），否则同档换模型会被误判为升档。
          // 【curTier===null 必须视为升档】起手模型常不在池内（例如 defaultModel 指向一个池外模型，
          //   tierOf 返回 null），若当作「未升档」就会完全跳过确认 —— 恰好是「花着钱但没人问」的
          //   最坏情形。档位未知时保守当作升档：花钱需要同意，不知道从哪升上来时更需要同意。
          const curTier = tierOf(currentId, cfg);
          const tierRank = (t: Tier) => TIER_DESCENT.length - TIER_DESCENT.indexOf(t);
          const upgrading = curTier === null || tierRank(wantTier) > tierRank(curTier);
          if (upgrading && needsUpgradeConfirm(wantModel, wantTier, nightNow, cfg, dec.health)) {
            const approved = await confirmUpgrade(ctx, wantModel, wantTier, curTier, pChars, cfg);
            if (!approved) {
              costGuard = {
                action: "upgrade_declined", target: wantModel, tier: wantTier,
                rate: rateOf(wantModel), promptChars: pChars,
                reason: ctx.hasUI ? "user_declined_or_timeout" : "no_ui",
              };
              outcomes.costGuardDeclined += 1;
              declinedUpgrade = true; // 留在原档：不调 setModel
            } else {
              costGuard = { action: "upgrade_approved", target: wantModel, tier: wantTier, rate: rateOf(wantModel) };
              outcomes.costGuardConfirmed += 1;
            }
          }
        }

        if (declinedUpgrade) {
          decision = "no_change";
        } else {
          const target = resolveModel(ctx.modelRegistry, ctx.model?.provider ?? cfg.defaultProvider, wantModel);
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
      }

      // 档位→思考等级：只在本扩展**自己切成功**之后施加（用户手动 /thinking 不经过此路径）。
      // 键＝解析后 provider/id（switchedTo 即该形态）；不能用 dec.model——那是池项写法，查不中配置。
      const thinkingLevel =
        decision === "switched" && switchedTo ? applyThinkingTier(pi, switchedTo, dec.tier, cfg) : null;

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
        thinkingLevel,
        // 成本护栏轨迹：null 表示未触发（目标非付费，或护栏关闭）
        costGuard,
      });
    } catch (e) {
      appendLog({ ts, stage: "before_agent_start", err: String(e).slice(0, 300) });
    }
  });

  // ── Phase 3 ①+②（v0.11.0）：工具调用观测（mid-thread 升档）+ 子代理自动分档 ──
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
          const pChars = [...task].length;
          const night = isNight(new Date().getHours(), cfg.timeGate);
          const health = await probeHealth(cfg);
          const anchor = guardedAnchorFor(cls.tier, pChars, night, cfg, health);
          if (anchor) {
            input.model = anchor.model;
            outcomes.subagentTiered += 1;
            if (anchor.guard) outcomes.costGuardRedirected += 1;
            appendLog({
              ts: new Date().toISOString(), type: "subagent_tier",
              taskPreview: [...task].slice(0, 60).join(""),
              tier: cls.tier, rule: cls.rule, score: cls.score, lane: cls.lane,
              model: anchor.model, landedTier: anchor.tier, agent: input.agent ?? null, gear,
              costGuard: anchor.guard,
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
  // 【为什么两件事同一个 handler】mid-thread 升档与尝试预算共用同一个信号源（回合内**连续**
  //   工具失败计数），分成两个 handler 会变成「两个真相」——执行先后无法保证，
  //   `upgradedThisTurn` 会读脏。落在一个 handler 里，次序即代码次序。
  // 【顺序】先试升档（换模型再试一次），升不动了才判弃——见 attemptBudgetExhausted 注释。
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!event.isError) { toolFailStreak = 0; return; }
      toolFailStreak += 1;
      if (gear === "manual") return; // 手动挡绝对优先：用户锁的模型不由路由器擅动
      const curId = ctx.model?.id;
      const curTier = curId ? tierOf(curId, cfg) : null;
      if (!curId || !curTier) return; // 越池模型（手动强制）不参与升级/放弃

      // ① mid-thread 升档（v0.11.0 语义不变）
      const up = upgradeTierForStreak(curTier, cfg);
      if (up) {
        const nightNow = isNight(new Date().getHours(), cfg.timeGate);
        const upHealth = await probeHealth(cfg);
        const anchor = anchorFor(up.tier, nightNow, cfg);
        let targetId = anchor && anchor.model !== curId ? anchor.model : null;
        // ── 成本护栏（与 before_agent_start 同用一套纯函数，单一真相）──
        // 升档路径与主路径同样是「自动切换」，故同样受约束；否则升档会成为绕过成本护栏的后门。
        // 与主路径的差别：此处无 event.prompt，用上一次 prompt 的长度（同回合内即本回合的 prompt）。
        if (targetId && anchor) {
          const pChars = [...(lastPrompt ?? "")].length;
          const freeAlt = freeInsteadOfPaid(targetId, anchor.tier, pChars, nightNow, cfg, upHealth);
          if (freeAlt) {
            outcomes.costGuardRedirected += 1;
            appendLog({
              ts: new Date().toISOString(), type: "cost_guard", action: "paid_to_free",
              stage: "mid_thread_upgrade", from: targetId, to: freeAlt, tier: anchor.tier,
              paidRate: rateOf(targetId), promptChars: pChars, gear,
            });
            targetId = freeAlt;
          } else if (needsUpgradeConfirm(targetId, anchor.tier, nightNow, cfg, upHealth)) {
            const approved = await confirmUpgrade(ctx, targetId, anchor.tier, curTier, pChars, cfg);
            appendLog({
              ts: new Date().toISOString(), type: "cost_guard",
              action: approved ? "upgrade_approved" : "upgrade_declined",
              stage: "mid_thread_upgrade", target: targetId, tier: anchor.tier,
              rate: rateOf(targetId), promptChars: pChars,
              reason: approved ? "user_approved" : ctx.hasUI ? "user_declined_or_timeout" : "no_ui",
              gear,
            });
            if (approved) outcomes.costGuardConfirmed += 1;
            else {
              outcomes.costGuardDeclined += 1;
              targetId = null; // 未获同意⇒本次不升档（留在原模型），交由 attemptBudget 决定是否放弃
            }
          }
        }
        const target = targetId ? resolveModel(ctx.modelRegistry, ctx.model?.provider, targetId) : undefined;
        if (target && targetId) {
          routerSwitching = true;
          let ok = false;
          try {
            ok = await pi.setModel(target);
          } finally {
            routerSwitching = false;
            lastRouterSwitchAt = Date.now();
          }
          if (ok) {
            upgradedThisTurn = true; // 每回合至多 1 次（防振荡）
            lastUpgradeAt = Date.now(); // 升档专用冷却起点（区别于普通 setModel）
            // 键＝解析后 provider/id（target 已解析），非池项 targetId
            const think = applyThinkingTier(pi, `${target.provider}/${target.id}`, anchor?.tier ?? up.tier, cfg);
            outcomes.midThreadUpgrades += 1;
            appendLog({
              ts: new Date().toISOString(), type: "mid_thread_upgrade",
              from: curId, to: targetId, fromTier: curTier, toTier: up.tier,
              landedTier: anchor?.tier ?? null, failStreak: toolFailStreak,
              threshold: cfg.midThread.failThreshold, gear,
              thinkingLevel: think,
            });
            return; // 刚升过档——本轮不再判弃（新模型需一次机会证明自己）
          }
        }
      }

      // ② 尝试预算（ask-for-help）：升不动 / 升完仍连败 ⇒ 停止本回合并交还人
      if (!attemptBudgetExhausted(cfg)) return;
      gaveUpThisTurn = true;
      outcomes.attemptsGaveUp += 1;
      appendLog({
        ts: new Date().toISOString(), type: "attempt_budget_exhausted",
        model: curId, tier: curTier, failStreak: toolFailStreak,
        giveUpAfter: cfg.attemptBudget.giveUpAfter, upgradedThisTurn,
        action: cfg.attemptBudget.stopTurn ? "abort_turn" : "notify_only", gear,
      });
      if (cfg.attemptBudget.notify) {
        const tip =
          `尝试预算耗尽：连续 ${toolFailStreak} 次工具失败（阈值 ${cfg.attemptBudget.giveUpAfter}），` +
          `当前 ${curTier} 档${upgradedThisTurn ? " 已升过档" : ""}仍失败 ⇒ 停止本回合。` +
          `建议：/model 换更强模型、补充关键信息，或人工介入。`;
        try {
          if (ctx.hasUI) ctx.ui.notify(tip, "warning");
          else process.stderr.write(`[router] ${tip}\n`);
        } catch {
        }
      }
      if (cfg.attemptBudget.stopTurn) ctx.abort();
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
      // 渠道级熔断计数：**先于**模型级冷却统计，使渠道整体故障时同渠道其他模型一并被
      //   排除（仅靠 markFailed 只能冷却被点名的单个模型）。统计范围含越池模型
      //   （渠道级判据不应局限于池内）。
      const chOf = channelOf(cur);
      const tripped = markChannelFailed(chOf, cfg);
      if (tripped) {
        appendLog({
          ts: new Date().toISOString(), type: "failover", from: cur,
          decision: "channel_tripped", reason: `channel_failure_threshold:${chOf}`,
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
    gaveUpThisTurn = false; // Phase 4：放弃标记同样按回合重置
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
    description: "Model Router 挡位管理：status | auto | manual [model] | shadow | active | stats | grey | grey-list | version",
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
      } else if (sub === "grey" || sub === "scan-grey") {
        // 灰名单恢复巡检（“到点就巡查确认，没到点就自动忽略，半人工核实”）。
        // 实现不在此重写探针：本处仅展示摘要与时点筛选结果（单一真相在巡检脚本里）。
        const list = disabledList(cfg);
        if (list.length === 0) {
          msg = "灰名单为空（无人工禁用项）";
        } else {
          const file = disabledModelsPath(cfg);
          msg = [
            `灰名单 ${list.length} 条（真源：${file}）`,
            `  ${list.join(", ")}`,
            "",
            "恢复巡检：用本仓的巡检脚本探活（与健康闸同一套判定语义）",
            "  · reviewAt 到点 ⇒ 探测；未到点 ⇒ 自动忽略（零请求）",
            "  · reviewAt=null ⇒ 视为可随时复检",
            "  · 只给建议，不自动改文件（半人工核实）",
            "",
            "可用 /router grey-list 只看时点状态（不探测）。",
          ].join("\n");
        }
      } else if (sub === "grey-list") {
        // 只列时点状态，不探测（零网络请求）——便于随时查看「哪些到点了」。
        const file = disabledModelsPath(cfg);
        const entries = disabledEntries(cfg);
        if (entries.length === 0) {
          msg = `灰名单为空（${file}）`;
        } else {
          const now = Date.now();
          const rows = entries.map((e) => {
            const ra = e.reviewAt ? Date.parse(e.reviewAt) : NaN;
            const state = !e.reviewAt || Number.isNaN(ra) ? "待复检" : ra <= now ? "待复检" : "未到点";
            return `  [${state}] ${e.id}${e.reviewAt ? ` reviewAt=${e.reviewAt}` : "（无时点）"}${e.reason ? `  ${e.reason}` : ""}`;
          });
          msg = [`灰名单 ${entries.length} 条（${file}）`, ...rows].join("\n");
        }
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
          `灰色(人工禁用): ${(() => {
            const l = disabledList(cfg);
            return l.length ? `${l.length} 条（${l.join(", ")}）— 候选链已剔除，/router grey-list 看时点` : "无";
          })()}`,
          `熔断(渠道级): ${(() => {
            const tripped = (cfg.channels ?? []).filter((ch: string) => isChannelTripped(ch, cfg));
            return tripped.length ? `冷却中 ${tripped.join(", ")}` : "无";
          })()}`,
          `排除表(永久): ${(() => {
            try {
              const doc = JSON.parse(readFileSync(join(dirname(disabledModelsPath(cfg)), "free-exclusions.json"), "utf8")) as { exclusions?: Record<string, unknown> };
              const n = Object.keys(doc.exclusions ?? {}).length;
              return `${n} 条（provider 下架等，见 free-exclusions.json）`;
            } catch {
              return "（读取失败）";
            }
          })()}`,
          `outcome(P2-4): 回合 ${outcomes.turns} | 错误回合 ${outcomes.retriedTurns} | 模型级限流 ${outcomes.modelErrors} | 泳道 code/knowledge/general ${outcomes.laneCount.code}/${outcomes.laneCount.knowledge}/${outcomes.laneCount.general}`,
          `用法: /router auto | /router manual [modelId] | /router shadow | /router active | /router stats | /router grey | /router grey-list | /router version（v${pkgVersion()}）`,
          `（决策明细: ${LOG_PATH}；回合 outcome: ${OUTCOME_LOG_PATH}）`,
        ].join("\n");
      }

      if (ctx.hasUI) ctx.ui.notify(msg, "info");
      else process.stderr.write(`[router] ${msg}\n`);
    },
  });
}

// ---- 测试面（具名导出）----
// pi 只读默认导出，故这些具名导出对运行时无副作用；它们让 tools/ 下的自测**直接测真实代码**
// 而不是另抄一份逻辑（抄一份会出现「测试全绿而真实代码是错的」）。
export {
  DEFAULTS,
  THINK_ORDER,
  stricterLevel,
  poolIdOf,
  isFreeInPricing,
  desiredThinkingLevel,
  freeSet,
  costKnowledge,
  costDataAvailable,
  applyThinkingTier,
};
