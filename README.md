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
   ├─ grey list          manually disabled models filtered out (unchanged pool)
   ├─ health gate ①      account-level gateway /status probe   (optional, fail-open)
   ├─ channel breaker    channels whose upstream is down are dropped entirely
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

The **channel breaker** fills a gap the account-level health gate cannot see: that probe reports
whether *accounts* are available, so a channel whose *upstream* is broken can still read `ok` while
every one of its models fails. Because a model-level cooldown only cools the single model that was
named, the next rotation would pick a sibling model on the same broken channel and eat the same
timeout again — which is how one outage presents itself as a run of consecutive truncations.
Counting failures **per channel** and cooling the whole channel lets rotation move to a different
channel instead. Note the breaker needs failures to *accumulate* (`failThreshold`), so it cannot
make the first failing request faster; what it removes is the repetition that follows.

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
- **Thinking levels: two axes, stricter wins** — free models are capped at `minimal`, paid models
  default to **off**, and the per-tier map (`Fast` → `minimal`, `Balanced` → `medium`,
  `Performance` → `high`) acts as the ceiling: the applied level is the stricter of the two
  (`off < minimal < low < medium < high < xhigh < max`). Paid means `off` with no flagship exception.
  Free/paid comes from the same free set the cost guard uses (pricing rows with `rate: 0` plus an
  explicit `pricing.freeModels` list), and **the axis only engages when that data is readable** —
  with no pricing source configured, behaviour is exactly the per-tier ceiling, so a default install
  is unaffected. Set `thinkingCost.enabled=false` to return to pure per-tier behaviour.
  Levels are applied after a router-initiated switch **and** on `session_start` / `model_select`, so
  the startup model and a manual `/model` are covered too (both paths are idempotent). A manual
  `/thinking` is never overridden, and an explicit per-model entry in `settings.modelThinkingLevels`
  wins over everything — that entry is keyed by the **resolved** `provider/modelId`, not by the
  pool-entry form: if your pool lists `my-gateway/gpt-x` but pi resolves it under provider
  `myprovider`, the key is `myprovider/my-gateway/gpt-x`. Using the pool form as the key silently
  fails to match.
  Note the deliberate trade-off: because a level is applied when a model is *selected*, a level the
  host remembered for that model from an earlier session is overwritten. Pin such models in
  `settings.modelThinkingLevels`.
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
| `thinkingTier` | `{ enabled: true, byTier: { Fast: "minimal", Balanced: "medium", Performance: "high" } }` | Per-tier thinking level, now the **ceiling** of the two axes (`minimal` / `low` / `medium` / `high` / `xhigh` / `max`). A manual `/thinking` or an explicit `modelThinkingLevels` entry takes precedence |
| `thinkingCost` | `{ enabled: true, freeMax: "minimal", paid: "off" }` | Cost axis: free models capped at `freeMax`, paid models defaulted to `paid` (no flagship exception). Applied where the stricter of the two axes wins, on a router switch and on `session_start` / `model_select`. Engages only when cost data is readable (a non-empty `pricing.freeModels`, or a parseable pricing file); `enabled: false` restores the pure per-tier behaviour |
| `costGuard` | `{ enabled: true, shortPromptChars: 200, confirmUpgradeTiers: ["Performance"], confirmTimeoutSec: 120 }` | Free-first inside a tier unless the prompt is ≤ `shortPromptChars`; a paid escalation into `confirmUpgradeTiers` asks first. Decline / timeout / no UI ⇒ stay in the current tier |
| `errorFeedback.*` | see source | Rate-limit cooldowns + recent-error window (`recentErrorRateThreshold: 0.34`) |
| `channelBreaker` | `{ enabled: true, windowSec: 900, failThreshold: 3, cooldownSec: 900 }` | Channel-level circuit breaker: `failThreshold` failures from one channel inside `windowSec` trip the **whole channel** for `cooldownSec`. Covers the gap where a channel's upstream is down while the account-level health probe still reports `ok` |
| `disabledModels` | `[]` | Inline disable-list — **fallback only**: used when `disabledModelsFile` is missing or unreadable |
| `disabledModelsFile` | `"disabled-models.json"` | Disable-list file (relative to the extension dir). The file wins over the inline array. See [Grey models](#grey-models-manual-disable-list) |
| `defaultProvider` | `""` | Provider fallback when `ctx.model` is unset at decision time |
| `promptPreviewChars` | `300` | Prompt text kept in the decision log for audit; `0` keeps prompts off disk entirely |

**Environment variables** (all optional):

| Variable | Purpose |
|---|---|
| `PI_CODING_AGENT_DIR` | Agent dir (config discovery) — defaults to `~/.pi/agent` |
| `MODEL_ROUTER_STATE_DIR` | State/log dir — defaults to `~/.local/state/model-router` |
| `MODEL_ROUTER_PRICING` | Overrides `pricing.file` (useful for migration and isolated tests) |
| `MODEL_ROUTER_GATEWAY_CONFIG` | Path to a JSON file containing `api_key` for the health probe (credentials are never read unless set, and never written anywhere) |
| `MODEL_ROUTER_DISABLED_MODELS` | Overrides `disabledModelsFile` (absolute path to the disable-list file) |
| `MODEL_ROUTER_GATEWAY_URL` / `MODEL_ROUTER_GATEWAY_KEY` | Gateway base URL / API key for the standalone `tools/scan_grey_models.py` inspector (see [Grey models](#grey-models-manual-disable-list)); the extension itself does not use them |

## Commands

```
/router                  status: gear, mode, pools, cooling, counters
/router auto             release manual lock → automatic routing
/router manual [modelId] lock the current (or a named) model
/router shadow|active    record-only ↔ real switching (session scope)
/router stats            in-process counters: turns, errors, lane split, mid-thread upgrades,
                         sub-agent tiering, attempts given up, thinking levels applied
                         (with the cost-axis state and whether cost data is present),
                         cost-guard redirects / confirmations / declines
/router grey             disable-list summary + how to run the recovery inspector
/router grey-list        time-gate status of every disable-list entry (no network requests)
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
├── tools/scan_grey_models.py        # disable-list recovery inspector (read-only, python3 stdlib)
├── tools/channel_breaker_selftest.mjs # circuit-breaker + disable-list truth tables (node)
├── tools/thinking_cost_selftest.mjs   # thinking-level truth tables + real hook paths (node ≥ 22)
├── model-router.config.example.json # copy to ~/.pi/agent/model-router.config.json
├── disabled-models.json             # grey-model list (template; see note)
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

## Grey models (manual disable list)

A **grey model** is one you have decided not to route to *for now* — typically a quota-exhausted
or rate-limited model that is expected to recover on its own. Greying a model filters it out of the
candidate chain **without changing the pool**, so `/router status` and the pool order still show it.

This is deliberately distinct from two neighbours:

| Mechanism | Nature | Lifetime | Where it lives |
|---|---|---|---|
| **Grey list** | manual judgement | temporary (expected recovery) | `disabled-models.json` |
| **Channel breaker** | automatic, self-healing | runtime cooling window | `channel-breaker-state.json` |
| **Exclusion table** | manual judgement | permanent (provider gone) | `free-exclusions.json` + remove from pool |

### Why the list is a file, not an inline array

`disabledModels` still exists in `DEFAULTS`, but only as a **fallback** for when the file is absent.
The list is a file because it usually has **more than one consumer** — this extension, plus anything
else you build on top (a frontend that greys these entries out, a monitoring job). An inline array
lives inside the extension's source; anything outside it cannot read that, so each consumer would
have to keep its own copy — and two copies of one list is a correctness bug waiting to happen.

### The file

```json
{
  "schema": "disabled-models-v1",
  "updatedAt": "2026-01-01T00:00:00+00:00",
  "models": [
    { "id": "my-provider/my-model",   "reason": "quota exhausted", "reviewAt": "2026-01-01T08:00:00+00:00" },
    { "id": "flaky-provider/*",        "reason": "channel outage",  "reviewAt": null }
  ]
}
```

- `id` — `<provider>/<modelId>`, or `<provider>/*` to disable a whole channel.
- `reviewAt` — the moment the entry becomes worth re-checking. Take it from whatever the upstream
  *itself* states: a `429` body usually names its own reset time (e.g. *"resets at 08:00 UTC+8"*).
  `null` means there is no declared recovery point (channel outage, free-tier throttling) and the
  entry is treated as re-checkable at any time.
- Entries may also be plain strings (`"my-provider/my-model"`) if you do not need the metadata.

The file is read with an **mtime cache**: it is hand-edited, so a change should take effect on the
very next decision. A TTL would keep serving the old list for the length of the window.

### Recovery inspection (semi-manual by design)

```bash
python3 tools/scan_grey_models.py             # probe only what is due
python3 tools/scan_grey_models.py --list      # show due-time status, no requests
python3 tools/scan_grey_models.py --all       # ignore reviewAt, probe everything
python3 tools/scan_grey_models.py --self-test # due-time truth table (no network)
```

**Not-yet-due entries are skipped with zero network requests.** Probing before `reviewAt` is
*guaranteed* to fail and therefore carries no information — it only burns quota and wall-clock time.
Provide the API key via `MODEL_ROUTER_GATEWAY_KEY` or `MODEL_ROUTER_GATEWAY_CONFIG`; point the tool at
your gateway with `MODEL_ROUTER_GATEWAY_URL`. Pass `--pool-file` (one `<provider>/<model>` per line)
if you want `<provider>/*` entries expanded into concrete models.

Availability is a **random variable, not a boolean** — the same model can return `429` and `200`
within the same minute. So the verdict is based on a **success rate**: one `200` anywhere is enough
to avoid declaring a model dead, and only deterministic failures count against it. The exit codes
follow the same convention as the sibling health checks (see `--json` for machine-readable output):

| Exit | Meaning |
|---|---|
| `0` | nothing recovered, or everything not yet due |
| `10` | at least one entry looks recovered — remove it from the list by hand |
| `2` | could not load the list or reach the gateway |

The tool **never edits the list for you.** A single lucky `200` is not proof of recovery, and letting
a script silently promote that into a configuration change is exactly the failure mode this design
avoids. The machine gathers evidence; a human makes the call.

## Calibration workflow

```bash
node --experimental-strip-types tools/thinking_cost_selftest.mjs   # 58 thinking-level assertions
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
