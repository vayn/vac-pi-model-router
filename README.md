<div align="center">

# pi-model-router

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)]()
[![Pi](https://img.shields.io/badge/pi-extension-orange)](https://github.com/earendil-works/pi)

> Two-gear model routing for the [pi coding agent](https://github.com/earendil-works/pi):
> the router picks the model, you keep the kill switch.

</div>

[中文说明](README.zh-CN.md) — Chinese version

**pi-model-router** is an extension that automatically switches the active model per turn based on
*task difficulty*, with three levels of health gating, error feedback, and a manual lock that always
wins. It is designed for setups with **multiple models across one or more providers** (gateway or
direct): cheap models for easy prompts, capable models for hard ones, free-window models only when
they are actually free.

## Features

### Two gears, two modes

| | |
|---|---|
| **Gear: auto** | The router classifies each prompt and switches models via `setModel` |
| **Gear: manual** | You locked a model (`/router manual`) — the router never interferes |
| **Mode: active** | Real switching |
| **Mode: shadow** | Record-only dry run (observe decisions without switching) |

Manual gear is absolute: any non-router `model_select` (the `/model` command, UI picker, RPC)
locks the session; `/router auto` releases it.

### Decision pipeline

Every decision is logged with a full `gateChain` trace so it can be replayed offline:

```
classify()  ── rule-based tier: Fast / Balanced / Performance
   │
   ├─ time gate          optional free-window model only at night
   ├─ health gate ①      account-level gateway /status probe   (optional, fail-open)
   ├─ health gate ②      model-level cooldown (rate-limit / unavailable windows)
   ├─ health gate ③      recent-error de-prioritization from outcome log
   ├─ failover cooldown  models that failed recently are skipped
   ├─ in-tier hold       don't churn inside the current tier
   ├─ lane preference    code / knowledge lane affinity
   └─ cascade downgrade  Performance → Balanced → Fast → no_viable
```

Gate ③ deserves a note: it **de-prioritizes** (moves a recently error-prone model to the end of the
viable list) instead of removing it — "recently flaky" ≠ "currently unavailable", and hard removal
can collapse a sparse pool into `no_viable`.

### How classification works

The classifier is a saturating, weighted rule scorer. Each dimension is normalized as
`n/(n+k)` before weighting, so repeating a keyword does not scale the score:

| Dimension | Saturation `k` | Weight | Note |
| --- | --- | --- | --- |
| `HARD` (architecture, root cause, trade-offs, security…) | 1 | 0.60 | The only signal that can reach `Performance` on its own |
| `AGENTIC` (fix, refactor, deploy, debug…) | 3 | 0.40 | Code fences and long prompts fold in as weak evidence (≤0.5) |
| `EASY` (what is, translate, define…) | 2 | 0.20 | A penalty, deliberately outside the positive weight budget |

Tiers are cut at `score >= 0.40 → Performance`, `>= 0.15 → Balanced`, else `Fast`, with an
`EASY`-only fast path for short prompts. `Performance` still requires `HARD` **plus**
corroborating evidence — a single keyword is never enough, matching the conservative
behaviour the classifier always had.

Every decision row records `classified` and `scoreBreakdown` alongside the score, so you can
tell "judged Balanced" from "no signal matched, defaulted to Balanced", and see which
dimension drove a tier. `clsVersion` is stamped too, which matters for calibration: scores
from different classifier versions live on different scales and must never be pooled.


### Execution-time adaptation (Phase 3–5)

Two layers read the same signal — *consecutive* tool failures inside one turn — and run in
order: try a stronger model first, and only give up when there is nothing left to try.

- **Mid-thread upgrade** — three *consecutive* tool failures inside one turn mean the prompt was
  misclassified as easy; the router upgrades one tier (max once per turn, with cooldown). One
  success resets the streak: consecutive failures are the difficulty signal, sporadic ones are noise.
  The upgrade target comes from `anchorFor()`, which walks the downgrade chain to the first tier
  that has a candidate valid *right now* (the time gate is honoured), so an upgrade never lands on
  a model that is unavailable at this hour.
- **Attempt budget** — five consecutive failures mean retrying is not working. The router records
  the decision, prints a notice and **ends the turn**, handing the problem back to you. Because the
  upgrade may be spent only once per turn, without this layer a session that kept failing would
  keep failing in silence. `graceAfterUpgradeSec` stops a freshly upgraded model from being written
  off before it has had a chance to answer.
- **Thinking level per tier** — `Fast` → `minimal`, `Balanced` → `medium`, `Performance` → `high`.
  Applied only when this extension switched the model itself, so a manual `/thinking` is never
  overridden, and an explicit per-model entry in `settings.modelThinkingLevels` wins over it.
  That entry is keyed by the **resolved** `provider/modelId`, not by the pool-entry form: if your
  pool lists `my-gateway/gpt-x` but pi resolves it under provider `myprovider`, the key is
  `myprovider/my-gateway/gpt-x`. Using the pool form as the key silently fails to match.
- **Cost guard** — two rules that stop automatic switching from spending money silently. Free/paid
  is decided by the **same** set `freeFirst` uses (pricing rows with `rate == 0` ∪ the explicit
  `pricing.freeModels` list); a model missing from the table counts as **paid** (conservative).
  - *Rule 1 — free first within the tier*: if the model about to be switched to is paid and the
    **same tier has a usable free candidate** (not cooling, channel healthy), the router switches
    to that free candidate instead. The tier was already chosen by the classifier, so a free peer
    inside it costs nothing in capability — paying more for the same tier buys nothing. A very
    short prompt (`shortPromptChars`) is the one exception, because its absolute cost is negligible
    while a free model's cold-start or rate-limit delay usually exceeds the saving.
  - *Rule 2 — confirm a paid escalation*: escalating into a tier listed in `confirmUpgradeTiers`
    (default `Performance`) to a paid model, when that tier has **no** free candidate, pops a
    dialog. Declining, letting it time out, or having no dialog-capable UI (`ctx.hasUI` false,
    e.g. headless) leaves the current tier untouched — no consent, no spend.
  - The dialog shows only the **rate multiplier** and says so. `rate` is relative (baseline `1.0`)
    and there is deliberately no credit↔token conversion, so an absolute credit figure cannot be
    computed; the extension reports the multiplier rather than inventing a number.
  - Sub-agent injection runs inside `tool_call` and **must not block on a dialog** (it would stall
    the tool call, and a workflow with several children would prompt repeatedly), so there it takes
    the no-consent branch: a tier that would require confirmation is **stepped down one tier**.
- **Sub-agent tiering** — the `subagent` tool's task is classified independently and the tier's
  anchor model is injected into `input.model`. An explicitly specified model is never overridden.
- **Same-turn requeue** — when a model-level rate limit hits and rotation succeeded within the
  tier, the original prompt is replayed once (throttled), because pi does not retry opaque
  `429 (no body)` first-packet errors on its own.

### Observability & calibration

- `decision-log.jsonl` — one row per decision: classifier signals, score, tier, health snapshot,
  full `gateChain`, outcome (`switched` / `no_change` / `no_viable` / `model_not_found` / …).
  Append-only with 8 MB rotation (keeps one generation).
- `outcome-log.jsonl` — one row per turn (`ok` / `error`, error kind, latency), joined back to the
  decision via `decisionId`.
- `tools/router_calibrate.py` — **offline, read-only** calibration report: per-tier / per-model
  success rates, rate-limit rates, latency percentiles. It prints ⚠ suggestions and refuses to
  draw conclusions below a sample floor (`--min-n`, default 30). You review the report and edit
  the `DEFAULTS` constants yourself — there is no online self-adaptation on purpose (early samples
  are noise-dominated, and self-tuning makes behavior unexplainable).

## Installation

**As a local extension** (single file):

```bash
cp extensions/model-router.ts ~/.pi/agent/extensions/
```

**As a local pi package** (recommended — keeps `package.json` manifest):

```bash
cp -r . ~/pi-packages/model-router
pi install ~/pi-packages/model-router
```

**Via `settings.json` packages** (local path entry):

```json
{ "packages": ["../../pi-packages/model-router"] }
```

The extension loads on the next session start; no pi restart required.

## Quick start

1. **Declare your pools** in `~/.pi/agent/model-router.config.json` (copy
   [`model-router.config.example.json`](model-router.config.example.json)):

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

   Until you do, the placeholder pools are used and switches resolve to `model_not_found`
   (logged, session unaffected — the router never blocks a session).

2. **Optional health probe** — set `health.url` to a gateway status endpoint. Leave it empty
   (the default) for zero network traffic; an unreachable endpoint fails open.

3. Check it: run `/router` in a session for gear/mode/pool/cooling status, `/router stats` for
   counters.

## Configuration

All knobs live in `DEFAULTS` (see [`extensions/model-router.ts`](extensions/model-router.ts)) and
can be overridden via `~/.pi/agent/model-router.config.json`. `pool` overrides per tier; other
objects are replaced shallowly — provide the full object when overriding.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for the decision flow |
| `mode` | `"active"` | `active` = switch, `shadow` = record only |
| `pool` | placeholders | `<provider>/<modelId>` lists per tier; **order = priority** (anchor first) |
| `timeGate.model` | `""` | Model id gated to `startHour`–`endHour`; empty = disabled |
| `pricing.file` | `""` | Pricing table (`{model, channel, rate}`); `rate: 0` = free. Empty = feature off, pool order used as written |
| `pricing.freeModels` | `[]` | Explicit free-model ids, for deployments without a pricing table |
| `health.url` | `""` | Gateway `/status` endpoint; empty = probe disabled (fail-open) |
| `health.timeoutMs` / `ttlSec` | `600` / `60` | Probe timeout / cache TTL |
| `channels` | `["your-provider"]` | Channel names matching pool entry prefixes and `/status` `accounts` keys |
| `failover.cooldownSec` | `300` | Post-failure model cooldown (prevents two-model flip loops) |
| `failover.primary` / `fallback` | placeholders | **Display-only** — shown by `/router status` for readability; real rotation follows pool order |
| `lanePref` | `{ code: [], knowledge: [] }` | In-tier preference per lane (`code` / `knowledge`) |
| `midThread` | `{ enabled: true, failThreshold: 3, cooldownSec: 60 }` | Consecutive tool failures → 1-tier upgrade |
| `subagentTier` | `{ enabled: true }` | Independent tiering of `subagent` tasks |
| `attemptBudget` | `{ enabled: true, giveUpAfter: 5, notify: true, stopTurn: true, graceAfterUpgradeSec: 30 }` | Consecutive tool failures → record, notify and end the turn (ask-for-help). Keep `giveUpAfter` **above** `midThread.failThreshold` so upgrading is tried first |
| `thinkingTier` | `{ enabled: true, byTier: { Fast: "minimal", Balanced: "medium", Performance: "high" } }` | Thinking level applied after an extension-initiated switch (`minimal` / `low` / `medium` / `high` / `xhigh` / `max`). A manual `/thinking` or an explicit `modelThinkingLevels` entry takes precedence |
| `costGuard` | `{ enabled: true, shortPromptChars: 200, confirmUpgradeTiers: ["Performance"], confirmTimeoutSec: 120 }` | Free-first inside a tier unless the prompt is ≤ `shortPromptChars`; a paid escalation into `confirmUpgradeTiers` asks first. Decline / timeout / no UI ⇒ stay in the current tier |
| `errorFeedback.*` | see source | Rate-limit cooldowns + recent-error window (`recentErrorRateThreshold: 0.34`) |
| `defaultProvider` | `""` | Provider fallback when `ctx.model` is unset at decision time |
| `promptPreviewChars` | `300` | Prompt text kept in the decision log for audit; `0` keeps prompts off disk entirely |

**Environment variables** (all optional):

| Variable | Purpose |
|---|---|
| `PI_CODING_AGENT_DIR` | Agent dir (config discovery) — defaults to `~/.pi/agent` |
| `MODEL_ROUTER_STATE_DIR` | State/log dir — defaults to `~/.local/state/model-router` |
| `MODEL_ROUTER_PRICING` | Overrides `pricing.file` (useful for migration and isolated tests) |
| `MODEL_ROUTER_GATEWAY_CONFIG` | Path to a JSON file containing `api_key` for the health probe (credentials are never read unless set, and never written anywhere) |

## Commands

```
/router                  status: gear, mode, pools, cooling, counters
/router auto             release manual lock → automatic routing
/router manual [modelId] lock the current (or a named) model
/router shadow|active    record-only ↔ real switching (session scope)
/router stats            in-process counters: turns, errors, lane split, mid-thread upgrades,
                         sub-agent tiering, attempts given up, thinking levels applied,
                         cost-guard redirects / confirmations / declines
/router version          extension version
```

## Expected health endpoint shape

Only needed if you set `health.url` — a channel is healthy when at least one account is
`!cooling && !disabled`:

```json
{
  "accounts": {
    "your-provider": [{ "cooling": false, "disabled": false }]
  }
}
```

If the response shape doesn't match, the probe reports `http_error`/`unknown` and the health gate
fails open — routing continues unaffected.

## Logs & privacy

All state is local, under `MODEL_ROUTER_STATE_DIR`:

```
decision-log.jsonl   per-decision audit trail (append-only, 8 MB → .1 rotation)
outcome-log.jsonl    per-turn outcome, joined by decisionId
error-state.json     model-level cooldown windows
failover-state.json  rotation cooldown windows
```

- **No credentials** are written to any log or state file.
- Decisions never enter the model's context (the router acts through `setModel`, not prompts).
- `promptPreview` truncates prompts to `promptPreviewChars` (default 300) for audit purposes —
  set it to `0` if you don't want prompt text on disk at all.

## Graceful degradation

The router never breaks a session **by failing**:

- unknown model id → `decision: model_not_found`, session keeps its current model
- health endpoint down → health gate fails open
- state dir unwritable → logging swallowed, routing continues
- any exception inside a hook → caught and logged as a `stage` error row

Two behaviours interrupt a turn **deliberately**, and both are bounded and configurable — this
corrects an earlier, over-broad version of the claim above:

- `attemptBudget` — after `giveUpAfter` consecutive tool failures the extension records the
  decision, notifies you and **ends the turn**. That is the ask-for-help contract: hammering a
  model that has already failed repeatedly is not a working state.
- `costGuard` — a paid escalation pops a dialog and therefore **blocks until you answer or**
  `confirmTimeoutSec` **elapses**; a timeout is treated as a decline. In a headless session there
  is nobody to ask, so it declines immediately instead of spending.

Neither changes the model behind your back: the worst outcome of the guard is "stay where you
are", and the worst outcome of the budget is "stop and hand the problem back".

## Repository layout

```
model-router/
├── package.json                     # pi package manifest (pi.extensions)
├── extensions/model-router.ts       # the extension (single file, no runtime deps)
├── tools/router_calibrate.py        # offline read-only calibration report (python3 stdlib)
├── model-router.config.example.json # copy to ~/.pi/agent/model-router.config.json
├── free-exclusions.json             # optional free-model coverage contract (see note)
├── CHANGELOG.md
├── LICENSE
├── README.md                        # this file (English)
├── README.zh-CN.md                  # Chinese version
└── .gitignore
```

`free-exclusions.json` implements an optional governance contract: if your gateway advertises free
models (e.g. `free=true` with `rate=0`), every one of them must either appear in a pool or in this
exclusion table with evidence — so newly added free models can't be silently ignored. The extension
itself does not read this file; it exists for your own gates/audits.

## Calibration workflow

```bash
python3 tools/router_calibrate.py             # full report
python3 tools/router_calibrate.py --days 7    # last week only
python3 tools/router_calibrate.py --min-n 50  # stricter sample floor
python3 tools/router_calibrate.py --json      # machine-readable
```

Exit code `2` means no usable outcome data yet (empty/missing `outcome-log.jsonl`) — the script
never fabricates conclusions. When it flags a tier or model with a real sample size, edit the
`DEFAULTS` constants (classifier regexes, pool order, thresholds) and commit the change with the
evidence — rule changes should always be data-backed.

## License

MIT — see [LICENSE](LICENSE).
