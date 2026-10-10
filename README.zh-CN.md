<div align="center">

# pi-model-router

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)]()
[![Pi](https://img.shields.io/badge/pi-extension-orange)](https://github.com/earendil-works/pi)

> [pi coding agent](https://github.com/earendil-works/pi) 的两挡模型路由扩展：
> 路由器负责挑模型，你握着保险丝。

</div>

**pi-model-router** 按**任务难度**逐回合自动切换当前模型，带三级健康闸、错误反馈，以及一挡
永远优先的手动锁。它面向**单 provider 或多 provider（网关/直连皆可）下持有多个模型**的场景：
简单问题用便宜模型，难任务用强模型，限免模型只在真正免费的时候用。

[English README](README.md) — 英文版

## 特性

### 两挡位，两模式

| | |
|---|---|
| **挡位 auto** | 路由器分类每条 prompt 并通过 `setModel` 切换模型 |
| **挡位 manual** | 你锁定了模型（`/router manual`）—— 路由器绝不干预 |
| **模式 active** | 真实切换 |
| **模式 shadow** | 只记录不切换的灰度试运行（观察决策，不改行为）|

手动挡是绝对的：任何非路由器的 `model_select`（`/model` 命令、界面选择、RPC）都会把该会话
切为手动挡；`/router auto` 解除。

### 决策链

每次决策都带完整 `gateChain` 留痕，可离线回放：

```
classify()  ── 规则分层分类器：Fast / Balanced / Performance
   │
   ├─ 时段闸            限免模型仅夜间可选
   ├─ 灰名单            人工禁用的模型被剔除（不改池构成）
   ├─ 健康闸 ①          账号级：网关 /status 探测     （可选，fail-open）
   ├─ 渠道熔断          上游挂掉的渠道整体剔除
   ├─ 健康闸 ②          模型级：限流 / 不可用冷却窗
   ├─ 健康闸 ③          频次级：按近期错误率降权
   ├─ failover 冷却      近期失败过的模型跳过
   ├─ 同档持位           当前档位可行则不乱切
   ├─ 泳道偏好           code / knowledge 泳道亲和
   └─ 级联降档           Performance → Balanced → Fast → no_viable
```

健康闸 ③ 值得说明：它对近期易错模型是**降权**（挪到可行列表末尾）而非剔除 ——
「近期常错」不等于「当前不可用」，硬剔除会把稀疏的候选池逼向 `no_viable`。

**渠道熔断**补的是账号级健康闸的盲区：那一层探的是**账号**是否可用，所以一个**上游整体挂掉**
的渠道仍可能报 `ok`，而它的每个模型都在失败。又因为模型级冷却只冷却**被点名的单个模型**，
下次轮转会选到同渠道的兄弟模型、再吃一次同样的超时 —— 一次故障就这样表现为「连续多次截断」。
按**渠道**累计失败并冷却整渠道，轮换才能落到别的渠道。注意熔断需要失败**累计**到阈值
（`failThreshold`），所以它**不能让第一个失败请求变快**；它消除的是其后的重复。

### 分类器如何工作

分类器是**饱和加权规则打分**。每个维度先按 `n/(n+k)` 归一化再加权，因此重复关键词**不会**放大分数：

| 维度 | 饱和点 `k` | 权重 | 说明 |
|---|---|---|---|
| `HARD`（架构、根因、权衡、安全…）| 1 | 0.60 | 唯一能单独进入 `Performance` 的信号 |
| `AGENTIC`（修复、重构、部署、调试…）| 3 | 0.40 | 代码围栏与长 prompt 作为弱证据并入（≤0.5）|
| `EASY`（什么是、翻译、定义…）| 2 | 0.20 | 惩罚项，刻意不计入正向权重预算 |

档位切分：`score >= 0.40 → Performance`，`>= 0.15 → Balanced`，否则 `Fast`；短 prompt 走
`EASY` 专用快速通道。`Performance` 仍要求 `HARD` **叠加**其它证据 —— 单个关键词永不单独进档，
这与分类器一贯的保守行为一致。

每条决策行在分数之外还记录 `classified` 与 `scoreBreakdown`，因此可以区分「判定为 Balanced」
与「无信号匹配、兜底为 Balanced」，并看出是哪个维度决定了档位。同时写入 `clsVersion`，
这对校准很重要：不同分类器版本的分数不在同一尺度上，**绝不可混算**。

### 执行期自适应（Phase 3–5）

两层读同一个信号 —— 同一回合内的**连续**工具失败 —— 且按序执行：先换更强的模型试，
升不动了才放弃。

- **mid-thread 升档** —— 同一回合内三次**连续**工具失败，说明该 prompt 被低估为简单；路由器
  升一档（每回合至多一次，带冷却）。一次成功即归零：连续失败才是难度信号，偶发失败是噪声。
  升档目标取自 `anchorFor()` —— 它沿降档链找到**当前时刻**确有可用候选的首个档位
  （时段闸被计入），因此升档绝不会落在一个此小时不可用的模型上。
- **尝试预算（ask-for-help）** —— 连续五次失败即认定「重试无效」：记录该决策、提示用户，
  并**结束本回合**，把问题交还给人。由于升档每回合至多一次，没有这一层时，升完那一级后再
  连败就只剩 agent 硬试而无人知晓。`graceAfterUpgradeSec` 保证刚升过档的模型在证明自己之前
  不会被立即判弃。
- **思考等级：两轴取较严者** —— 免费模型封顶 `minimal`，收费模型默认 **off**；档位映射
  （`Fast` → `minimal`、`Balanced` → `medium`、`Performance` → `high`）降为**上限**，最终施加
  的是两轴中较严的一个（`off < minimal < low < medium < high < xhigh < max`）。收费一律 off，
  旗舰无例外。免费/收费的判定源与成本护栏 `freeFirst` **同一套**集合；**且仅在该数据可读时
  成本轴才生效**（`pricing.freeModels` 非空，或定价表可解析）——未配成本源时行为等同纯档位上限，
  故默认安装不受影响；`thinkingCost.enabled=false` 可退回纯档位行为。施加面＝router 自切 +
  `session_start` + `model_select`（两条 hook 幂等），故起手模型与手动 `/model` 同样被覆盖。
  手动 `/thinking` 永不被打断；settings 中针对具体模型的 `modelThinkingLevels` 显式配置优先级最高。
  该配置的键是**解析后**的 `provider/modelId`，不是池项写法：若池内写的是 `my-gateway/gpt-x`，
  而 pi 把它解析到 provider `myprovider` 之下，则键为 `myprovider/my-gateway/gpt-x`；用池项写法
  作键会静默匹配不上。**代价须知**：由于在「模型被选定」时施加，宿主为该模型记住的历史等级会被
  覆写——需要保留的模型请在 `modelThinkingLevels` 中钉住。
- **成本护栏** —— 两道规则，阻止自动切档在无人知晓的情况下花钱。免费/收费的判定源与
  `freeFirst` **同一套**集合（定价表中 `rate == 0` 的行 ∪ 显式 `pricing.freeModels` 清单）；
  表中查不到的模型按**收费**处理（保守口径）。
  - *规则一·同档内免费优先*：若要切到的模型收费、而**同档存在可用免费候选**（未冷却、渠道健康），
    路由器改为切到那个免费候选。档位已由分类器定好，同档内的免费同伴不构成能力对价——为同一个
    档位多花倍率买不到任何东西。极短 prompt（`shortPromptChars`）是唯一例外：其绝对成本可忽略，
    而免费模型的冷启动/限流延迟往往大于省下的那点钱。
  - *规则二·付费升档需确认*：升入 `confirmUpgradeTiers` 列出的档位（默认 `Performance`）且目标收费、
    而该档**无**免费候选时弹窗征询。用户拒绝、超时，或没有可弹窗的 UI（`ctx.hasUI` 为 false，
    例如 headless）⇒ 保持当前档位不动：没有同意，就不花费。
  - 弹窗只显示**倍率**并明说这一点。`rate` 是相对倍率（基准 `1.0`），且刻意不做积分↔token 折算，
    故绝对积分数额算不出来；扩展报倍率而不是编一个数。
  - 子代理注入发生在 `tool_call` 内，**不能阻塞在弹窗上**（会卡住工具调用，且多个子代理的 workflow
    会反复打断），故走「无同意」分支：本应确认的档位**降一档**。
- **子代理自动分档** —— `subagent` 工具的 task 文本被独立分类，其档位锚位模型注入
  `input.model`。显式指定 model 时绝不覆盖。
- **同回合重发** —— 命中模型级限流且档内轮转成功后，重放原 prompt（带节流）。因为 pi 自身
  不会重试不透明的 `429（无 body）` 首包错误。

### 可观测性与校准

- `decision-log.jsonl` —— 每次决策一行：分类信号、分数、档位、健康快照、完整 `gateChain`、
  结果（`switched` / `no_change` / `no_viable` / `model_not_found` / …）。仅追加，
  8 MB 轮转（保留一代）。
- `outcome-log.jsonl` —— 每回合一行（`ok` / `error`、错误类型、时延），经 `decisionId` 与决策关联。
- `tools/router_calibrate.py` —— **离线、只读**的校准报告：按档/按模型的成功率、限流率、
  时延分位。它打印 ⚠ 建议，且在样本低于下限时（`--min-n`，默认 30）拒绝下结论。
  你审阅报告后自行修改 `DEFAULTS` 常量 —— 刻意不做在线自适应（早期样本噪声主导，
  自调参会让行为不可解释）。

## 安装

**作为本地扩展**（单文件）：

```bash
cp extensions/model-router.ts ~/.pi/agent/extensions/
```

**作为本地 pi 包**（推荐 —— 保留 `package.json` 清单）：

```bash
cp -r . ~/pi-packages/model-router
pi install ~/pi-packages/model-router
```

**经 `settings.json` 的 packages 本地路径条目**：

```json
{ "packages": ["../../pi-packages/model-router"] }
```

扩展在下一个会话启动时加载，无需重启 pi。

## 快速开始

1. **声明你的候选池**：在 `~/.pi/agent/model-router.config.json` 中（可复制
   [`model-router.config.example.json`](model-router.config.example.json)）：

```json
{
  "pool": {
    "Fast": ["openai/gpt-4o-mini", "anthropic/claude-haiku"],
    "Balanced": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
    "Performance": ["anthropic/claude-opus-4-1"]
  },
  "defaultProvider": "anthropic"
}
```

   在配置之前，占位池会让切换解析为 `model_not_found`（已记录日志，不影响会话 ——
   路由器永不阻断会话）。

2. **可选健康探测** —— 把 `health.url` 指向网关状态端点。留空（默认）则零网络流量；
   端点不可达时 fail-open。

3. 检查：会话中运行 `/router` 查看挡位/模式/池/冷却状态，`/router stats` 查看计数。

## 配置

全部开关位于 `DEFAULTS`（见 [`extensions/model-router.ts`](extensions/model-router.ts)），可经
`~/.pi/agent/model-router.config.json` 覆盖。`pool` 按档位覆盖；其他对象是浅替换 —— 覆盖时请给完整对象。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 决策流程总开关 |
| `mode` | `"active"` | `active` = 切换；`shadow` = 只记录 |
| `pool` | 占位符 | 每档 `<provider>/<modelId>` 列表；**次序即优先级**（锚位在前）|
| `timeGate.model` | `""` | 仅 `startHour`–`endHour` 可选的模型；空 = 关闭 |
| `pricing.file` | `""` | 定价表（`{model, channel, rate}`）；`rate: 0` 即免费。空 = 关闭该特性，按池内原序 |
| `pricing.freeModels` | `[]` | 显式免费模型清单，用于没有定价表的部署 |
| `health.url` | `""` | 网关 `/status` 端点；空 = 不探测（fail-open）|
| `health.timeoutMs` / `ttlSec` | `600` / `60` | 探测超时 / 缓存 TTL |
| `channels` | `["your-provider"]` | 通道名，需与池项前缀及 `/status` 的 `accounts` 键一致 |
| `failover.cooldownSec` | `300` | 模型失败后冷却（防两模型来回跳）|
| `failover.primary` / `fallback` | 占位符 | **仅展示语义** —— 由 `/router status` 显示以便阅读；实际轮转按池序 |
| `lanePref` | `{ code: [], knowledge: [] }` | 档内泳道优先候选（`code` / `knowledge`）|
| `midThread` | `{ enabled: true, failThreshold: 3, cooldownSec: 60 }` | 连续工具失败 → 升一档 |
| `subagentTier` | `{ enabled: true }` | `subagent` 任务独立分档 |
| `attemptBudget` | `{ enabled: true, giveUpAfter: 5, notify: true, stopTurn: true, graceAfterUpgradeSec: 30 }` | 连续工具失败达阈值 → 记录、提示并结束本回合（ask-for-help）。`giveUpAfter` 应**大于** `midThread.failThreshold`，以保证先尝试升档 |
| `thinkingTier` | `{ enabled: true, byTier: { Fast: "minimal", Balanced: "medium", Performance: "high" } }` | 档位思考等级，现为两轴的**上限**（`minimal` / `low` / `medium` / `high` / `xhigh` / `max`）。手动 `/thinking` 或 `modelThinkingLevels` 显式配置优先 |
| `thinkingCost` | `{ enabled: true, freeMax: "minimal", paid: "off" }` | 成本轴：免费封顶 `freeMax`、收费默认 `paid`（旗舰无例外）；与档位轴取较严者，施加于自切 + `session_start` + `model_select`。**仅在成本数据可读时生效**（`pricing.freeModels` 非空或定价表可解析）；`enabled: false` 退回纯档位行为 |
| `costGuard` | `{ enabled: true, shortPromptChars: 200, confirmUpgradeTiers: ["Performance"], confirmTimeoutSec: 120 }` | 同档内免费优先（极短 prompt 除外）；付费升入 `confirmUpgradeTiers` 前先征询。拒绝 / 超时 / 无 UI ⇒ 留在当前档 |
| `errorFeedback.*` | 见源码 | 限流冷却 + 近期错误窗口（`recentErrorRateThreshold: 0.34`）|
| `channelBreaker` | `{ enabled: true, windowSec: 900, failThreshold: 3, cooldownSec: 900 }` | 渠道级熔断：同一渠道在 `windowSec` 内失败达 `failThreshold` ⇒ 冷却**整渠道** `cooldownSec`。补的是「渠道上游挂掉、而账号级健康闸仍报 `ok`」这一盲区 |
| `disabledModels` | `[]` | 内联禁用清单 —— **仅作回退**：`disabledModelsFile` 缺失或不可读时使用 |
| `disabledModelsFile` | `"disabled-models.json"` | 灰名单文件（相对扩展目录）。文件优先于内联数组。见「灰名单」节 |
| `defaultProvider` | `""` | 决策时 `ctx.model` 未设置时的 provider 兜底 |
| `promptPreviewChars` | `300` | 决策日志中保留的 prompt 文本长度（审计用）；设为 `0` 则 prompt 完全不落盘 |

**环境变量**（全部可选）：

| 变量 | 用途 |
|---|---|
| `PI_CODING_AGENT_DIR` | agent 目录（配置发现）—— 默认 `~/.pi/agent` |
| `MODEL_ROUTER_STATE_DIR` | 状态/日志目录 —— 默认 `~/.local/state/model-router` |
| `MODEL_ROUTER_PRICING` | 覆盖 `pricing.file`（便于迁移与隔离测试）|
| `MODEL_ROUTER_GATEWAY_CONFIG` | 含 `api_key` 的健康探测配置 JSON 路径（未设置则不读取任何凭据，且凭据绝不写入任何地方）|
| `MODEL_ROUTER_DISABLED_MODELS` | 覆盖 `disabledModelsFile`（灰名单文件的绝对路径）|
| `MODEL_ROUTER_GATEWAY_URL` / `MODEL_ROUTER_GATEWAY_KEY` | 独立巡检脚本 `tools/scan_grey_models.py` 用的网关基址 / API key（见「灰名单」节）；扩展本体不用它们 |

## 命令

```
/router                  状态：挡位、模式、候选池、冷却中模型、计数
/router auto             解除手动锁 → 自动路由
/router manual [modelId] 锁定当前（或指定）模型
/router shadow|active    只记录 ↔ 真实切换（会话级）
/router stats            进程内计数：回合、错误、泳道分布、mid-thread 升档、子代理分档、
                         已放弃次数、已施加思考等级、成本护栏改走免费/已确认/被拒次数
/router grey             灰名单摘要 + 恢复巡检的运行方式
/router grey-list        逐条列出灰名单的时点状态（零网络请求）
/router version          扩展版本
```

## 健康端点期望形态

仅在设置了 `health.url` 时需要 —— 某通道至少一个账号 `!cooling && !disabled` 即视为健康：

```json
{
  "accounts": {
    "your-provider": [{ "cooling": false, "disabled": false }]
  }
}
```

若响应形态不符，探测会报 `http_error` / `unknown`，健康闸 fail-open —— 路由不受影响继续工作。

## 日志与隐私

所有状态都在本地，位于 `MODEL_ROUTER_STATE_DIR`：

```
decision-log.jsonl   每次决策的审计轨迹（仅追加，8 MB → .1 轮转）
outcome-log.jsonl    每回合 outcome，按 decisionId 关联
error-state.json     模型级冷却窗
failover-state.json  轮转冷却窗
```

- **任何日志或状态文件都不写入凭据**。
- 决策绝不进入模型上下文（路由器经 `setModel` 生效，不是 prompt）。
- `promptPreview` 为审计需要截断 prompt 至 `promptPreviewChars`（默认 300）——
   若你完全不希望 prompt 文本落盘，设为 `0`。

## 优雅降级

路由器不会因为**出错**而阻断会话：

- 未知模型 id → `decision: model_not_found`，会话保持当前模型
- 健康端点不可达 → 健康闸 fail-open
- 状态目录不可写 → 日志写入被吞掉，路由继续
- 钩子内任何异常 → 捕获并以 `stage` 错误行记录

但有两个行为是**有意**打断回合的，且都有边界、可配置 —— 上文旧版「永不阻断」的说法过宽，此处更正：

- `attemptBudget` —— 连续工具失败达 `giveUpAfter` 次后，扩展记录决策、提示用户，并**结束本回合**。
  这就是 ask-for-help 的约定：对着一个已经反复失败的模型继续硬试，不是一个可用状态。
- `costGuard` —— 付费升档会弹窗，因此**阻塞到你回答或 `confirmTimeoutSec` 超时**为止；超时按拒绝处理。
  headless 会话里没有人可问，于是立即拒绝，而不是擅自花费。

两者都不会在你不知情时改动模型：护栏最坏结果是「留在原档」，预算最坏结果是「停下并把问题交还给你」。

## 仓库结构

```
model-router/
├── package.json                     # pi 包清单（pi.extensions）
├── extensions/model-router.ts       # 扩展本体（单文件，无运行时依赖）
├── tools/router_calibrate.py        # 离线只读校准报告（python3 标准库）
├── tools/scan_grey_models.py        # 灰名单恢复巡检（只读，python3 标准库）
├── tools/channel_breaker_selftest.mjs # 渠道熔断 + 灰名单真值表自测（node）
├── tools/thinking_cost_selftest.mjs   # 思考等级真值表 + 真实 hook 路径自测（node ≥ 22）
├── model-router.config.example.json # 复制为 ~/.pi/agent/model-router.config.json
├── disabled-models.json             # 灰名单（模板）
├── free-exclusions.json             # 可选的免费模型覆盖契约（见下）
├── CHANGELOG.md
├── LICENSE
├── README.md                        # 英文版
├── README.zh-CN.md                  # 本文件（中文）
└── .gitignore
```

`free-exclusions.json` 实现一个可选的治理契约：若你的网关声明了免费模型（如 `free=true` 且
`rate=0`），每一个都必须出现在某个候选池中，或出现在本排除表并附证据 —— 这样网关新增免费模型
就不会被静默忽略。扩展本身不读取此文件；它供你自己的门禁/审计使用。

## 灰名单（人工禁用清单）

**灰名单模型** = 你决定**暂时**不路由过去的模型 —— 典型是额度耗尽或限流的模型，预期会自行恢复。
把模型置灰会把它从候选链中剔除，但**不改变池构成**，故 `/router status` 与池内顺序仍能看到它。

它刻意与两个邻居区分开：

| 机制 | 性质 | 生命周期 | 载体 |
|---|---|---|---|
| **灰名单** | 人工判定 | 临时（预期恢复）| `disabled-models.json` |
| **渠道熔断** | 自动、自愈 | 运行时冷却窗 | `channel-breaker-state.json` |
| **排除表** | 人工判定 | 永久（provider 下架）| `free-exclusions.json` + 移出池 |

### 为什么是文件而不是内联数组

`DEFAULTS` 里的 `disabledModels` 仍保留，但仅作**回退值**（文件缺失时用）。名单之所以是文件，
是因为它通常**不止一个消费方** —— 本扩展，加上你在其之上搭的其他东西（例如把灰项灰显的前端、
监控任务）。内联数组活在扩展源码里，外部读不到，于是每个消费方都只能各存一份拷贝 ——
而同一份名单存在两份拷贝，就是一个等着发生的正确性缺陷。

### 文件格式

```json
{
  "schema": "disabled-models-v1",
  "updatedAt": "2026-01-01T00:00:00+00:00",
  "models": [
    { "id": "my-provider/my-model",  "reason": "额度耗尽", "reviewAt": "2026-01-01T08:00:00+00:00" },
    { "id": "flaky-provider/*",      "reason": "渠道故障", "reviewAt": null }
  ]
}
```

- `id` —— `<provider>/<modelId>`，或 `<provider>/*` 禁用整渠道。
- `reviewAt` —— 该条目值得重新检查的时刻。取值应来自**上游自己的声明**：`429` 响应体通常写明
  自己何时重置（如「将在 08:00:00 UTC+8 重置」）。`null` 表示无声明的恢复时点（渠道故障、
  免费档限流），巡检视其为**可随时复检**。
- 若不需要元数据，条目也可直接写成字符串（`"my-provider/my-model"`）。

文件按 **mtime 缓存**读取：它是手工编辑的，改动应在下一次决策即生效。用 TTL 会在窗口期内
继续沿用旧名单。

### 恢复巡检（刻意设计为半人工）

```bash
python3 tools/scan_grey_models.py             # 只探测已到点的项
python3 tools/scan_grey_models.py --list      # 只看时点状态，零请求
python3 tools/scan_grey_models.py --all       # 忽略 reviewAt，全量探测
python3 tools/scan_grey_models.py --self-test # 时点判定真值表（零网络）
```

**未到点的条目会被跳过，且零网络请求。** 在 `reviewAt` 之前探测是**必然失败**的，因而不携带任何
信息量 —— 只是白白消耗配额与等待时间。凭据经 `MODEL_ROUTER_GATEWAY_KEY` 或
`MODEL_ROUTER_GATEWAY_CONFIG` 提供；用 `MODEL_ROUTER_GATEWAY_URL` 指向你的网关。若想让
`<provider>/*` 条目展开为具体模型，可传 `--pool-file`（每行一个 `<provider>/<model>`）。

可用性是**随机量而非布尔值** —— 同一模型在同一分钟内可能既 `429` 又 `200`。故判定基于**成功率**：
只要出现过一次 `200` 就不判死，只有确定性失败才计入。退出码与同类健康巡检同一约定
（机器可读输出见 `--json`）：

| 退出码 | 含义 |
|---|---|
| `0` | 无已恢复项，或全部尚未到点 |
| `10` | 至少一项看似已恢复 —— 请人工将其从名单移除 |
| `2` | 名单读取失败或网关不可达 |

该工具**绝不替你修改名单**。一次幸运的 `200` 不是恢复的证明；让脚本把这种偶然静默提升为配置变更，
正是本设计要避开的失效模式。机器负责取证，人负责决定。

## 校准工作流

```bash
node --experimental-strip-types tools/thinking_cost_selftest.mjs   # 思考等级 58 条判据
python3 tools/router_calibrate.py             # 全量报告
python3 tools/router_calibrate.py --days 7    # 仅最近一周
python3 tools/router_calibrate.py --min-n 50  # 更严格的样本下限
python3 tools/router_calibrate.py --json      # 机器可读
```

退出码 `2` 表示尚无可用 outcome 数据（`outcome-log.jsonl` 缺失/为空）—— 脚本绝不编造结论。
当它基于真实样本量标记出某档或某模型的问题时，请修改 `DEFAULTS` 常量（分类正则、池序、阈值）
并连同证据一起提交 —— 规则变更应当始终有数据支撑。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
