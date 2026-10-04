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
   ├─ 健康闸 ①          账号级：网关 /status 探测     （可选，fail-open）
   ├─ 健康闸 ②          模型级：限流 / 不可用冷却窗
   ├─ 健康闸 ③          频次级：按近期错误率降权
   ├─ failover 冷却      近期失败过的模型跳过
   ├─ 同档持位           当前档位可行则不乱切
   ├─ 泳道偏好           code / knowledge 泳道亲和
   └─ 级联降档           Performance → Balanced → Fast → no_viable
```

健康闸 ③ 值得说明：它对近期易错模型是**降权**（挪到可行列表末尾）而非剔除 ——
「近期常错」不等于「当前不可用」，硬剔除会把稀疏的候选池逼向 `no_viable`。

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

### 执行期自适应（Phase 3）

- **mid-thread 升档** —— 同一回合内三次**连续**工具失败，说明该 prompt 被低估为简单；路由器
  升一档（每回合至多一次，带冷却）。一次成功即归零：连续失败才是难度信号，偶发失败是噪声。
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
| `lanePref` | `{ code: [], knowledge: [] }` | 档内泳道优先候选（`code` / `knowledge`）|
| `midThread` | `{ enabled: true, failThreshold: 3, cooldownSec: 60 }` | 连续工具失败 → 升一档 |
| `subagentTier` | `{ enabled: true }` | `subagent` 任务独立分档 |
| `errorFeedback.*` | 见源码 | 限流冷却 + 近期错误窗口（`recentErrorRateThreshold: 0.34`）|
| `defaultProvider` | `""` | 决策时 `ctx.model` 未设置时的 provider 兜底 |

**环境变量**（全部可选）：

| 变量 | 用途 |
|---|---|
| `PI_CODING_AGENT_DIR` | agent 目录（配置发现）—— 默认 `~/.pi/agent` |
| `MODEL_ROUTER_STATE_DIR` | 状态/日志目录 —— 默认 `~/.local/state/model-router` |
| `MODEL_ROUTER_PRICING` | 覆盖 `pricing.file`（便于迁移与隔离测试）|
| `MODEL_ROUTER_GATEWAY_CONFIG` | 含 `api_key` 的健康探测配置 JSON 路径（未设置则不读取任何凭据，且凭据绝不写入任何地方）|

## 命令

```
/router                  状态：挡位、模式、候选池、冷却中模型、计数
/router auto             解除手动锁 → 自动路由
/router manual [modelId] 锁定当前（或指定）模型
/router shadow|active    只记录 ↔ 真实切换（会话级）
/router stats            进程内回合计数（回合 / 错误 / 升档）
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

路由器设计上永不阻断会话：

- 未知模型 id → `decision: model_not_found`，会话保持当前模型
- 健康端点不可达 → 健康闸 fail-open
- 状态目录不可写 → 日志写入被吞掉，路由继续
- 钩子内任何异常 → 捕获并以 `stage` 错误行记录

## 仓库结构

```
model-router/
├── package.json                     # pi 包清单（pi.extensions）
├── extensions/model-router.ts       # 扩展本体（单文件，无运行时依赖）
├── tools/router_calibrate.py        # 离线只读校准报告（python3 标准库）
├── model-router.config.example.json # 复制为 ~/.pi/agent/model-router.config.json
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

## 校准工作流

```bash
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
