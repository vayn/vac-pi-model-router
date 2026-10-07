# Changelog

Notable changes, newest first.

## v0.14.0

- **Cost guard — two rules so automatic tier switching cannot spend money silently.**
  Free/paid is judged by the *same* set `freeFirst` uses (pricing rows with `rate == 0` ∪ the
  explicit `pricing.freeModels` list); a model absent from the table is treated as **paid**
  (conservative). Configured by `costGuard`.
  - *Rule 1 — free first within the tier*: when the router is about to switch to a paid model and
    the **same tier** has a *usable* free candidate (not in a cooldown window, channel healthy),
    it switches to that free candidate instead. The tier is already the classifier's capability
    verdict, so a free peer inside it costs nothing in capability. A prompt of at most
    `shortPromptChars` characters is the single exception — its absolute cost is negligible while
    a free model's cold-start / rate-limit delay usually exceeds the saving.
  - *Rule 2 — a paid escalation asks first*: escalating into a tier listed in
    `confirmUpgradeTiers` (default `Performance`) to a paid model, when that tier has **no** free
    candidate, pops `ctx.ui.confirm`. Declining, letting it time out (`confirmTimeoutSec`), or
    having no dialog-capable UI ⇒ the session stays in its current tier. No consent, no spend.
- **Fix: a starting model outside the pool skipped the confirmation entirely.** The upgrade test
  was `curTier !== null && rank(target) > rank(cur)`; when the current model is not in any pool
  tier `tierOf()` returns `null`, so the conjunction short-circuited to *false* and no dialog was
  shown — precisely the "paying without asking" case. An unknown current tier is now treated as an
  upgrade: if we cannot tell what we are escalating *from*, we ask.
- **Sub-agent tiering takes the no-consent branch instead of prompting.** Injection happens inside
  `tool_call`, where a dialog would stall the tool call and prompt repeatedly across the children
  of a workflow, so a tier that would require confirmation is stepped **down one tier**
  (`guardedAnchorFor`). The short-prompt exception is not a way around this: it only suppresses
  rule 1; rule 2 still steps the tier down because there is nobody to ask.
- **The dialog reports the rate multiplier, never an absolute credit figure.** `rate` is relative
  (baseline `1.0`) and there is deliberately no credit↔token conversion, so the number cannot be
  computed; the text says so instead of inventing a figure.
- **Docs: corrected the over-broad "never breaks a session" claim.** `attemptBudget` (v0.13.0) and
  `costGuard` (this release) *do* interrupt a turn on purpose — bounded and configurable — and
  readers were relying on the opposite. Neither changes the model behind your back: the guard's
  worst case is "stay where you are", the budget's is "stop and hand the problem back".
- `decision-log.jsonl` rows gain a `costGuard` field (`paid_to_free` / `upgrade_approved` /
  `upgrade_declined` with reason `user_declined_or_timeout` or `no_ui`); standalone
  `type: "cost_guard"` rows are emitted on the escalation path. `/router stats` gains a Phase 5 line.

## v0.13.0

- **Fix: `PRICING_TTL_MS` was used but never defined.** The free-model cache check threw
  `ReferenceError` on every call after the first, which silently disabled free-model
  preference for the rest of the session (the throw is swallowed by the caller's `catch`).
  The first call passes only because the cache is still `null` and short-circuits the check.
  Defined the constant.

- **Fix: `defaultProvider` was documented and consumed but missing from `DEFAULTS`.** It
  therefore always read `undefined`; it is now declared alongside the other config keys.

- **Time gate is applied in one place.** It used to be filtered inside the decision loop
  only, while the mid-thread upgrade and the sub-agent tiering took their candidate
  straight from the pool — so during the day those two paths could pick a time-gated model
  and switch a struggling session onto a model that cannot serve it. The filter now lives
  in `candidatesFor()`, and a new `anchorFor()` walks the downgrade chain to the first
  usable tier, so every caller gets a candidate that is valid right now.

- **Attempt budget (ask-for-help).** A second, orthogonal layer on top of the mid-thread
  upgrade. `midThread` (threshold 3) swaps in a stronger model and keeps going;
  `attemptBudget` (threshold 5) concludes that retrying is not working, records the
  decision and **ends the turn** with a notice, handing the problem back to the user.
  Without it, once the single permitted upgrade had been spent the agent just kept
  retrying in silence. `graceAfterUpgradeSec` keeps a freshly upgraded model from being
  written off before it has had a chance to answer. Configurable and switchable via
  `attemptBudget`.

- **Thinking level per tier.** `Fast` → `minimal`, `Balanced` → `medium`,
  `Performance` → `high`. It is applied only when this extension switched the model
  itself, so a manual `/thinking` is never overridden, and an explicit per-model entry in
  `settings.modelThinkingLevels` takes precedence. Models without reasoning support are
  clamped by pi.

- **Fix: the thinking-level lookup used the wrong key.** The "user configuration wins"
  guarantee above was silently defeated: the lookup was passed the pool-entry form
  (`<channel>/<model>`) while pi keys `modelThinkingLevels` by the resolved
  `${provider}/${id}`. The two are not the same name — a pool entry `my-gateway/gpt-x`
  resolved under provider `myprovider` is keyed `myprovider/my-gateway/gpt-x`. A missing key
  is not an error, so a level you set was overridden with no signal. Both call sites now
  pass the resolved form.

- Both layers read the same counter and run in the same `tool_result` handler, in order:
  try the upgrade first, and only give up when there is nothing left to try. Two handlers
  would mean two sources of truth for one signal.

## v0.12.1

- **Fix: restore the classifier and configuration sections.** The v0.12.1 sync replaced a
  large span of the file with the free-model block, dropping `loadConfig`, the signal
  regexes, the classifier constants, `sat()`, `classify()`, `isNight()` and `resolveModel()`.
  The published file failed to parse and could not be loaded. Restored from the upstream
  source and re-verified by transpile check, a statement-set comparison of the classifier
  (equal), and an isolated end-to-end run.

- **Free models are preferred within each tier.** Free models sort ahead of paid ones, and
  the order inside each group is preserved. The pool stays the human-readable capability
  order; only the candidate order changes.
- Free status comes from data, not from naming. Two sources are combined: a pricing table
  (`pricing.file`, entries with `rate: 0`) and an explicit list (`pricing.freeModels`).
  Both empty means nothing is known to be free and the pool order is used as written.
  `MODEL_ROUTER_PRICING` overrides the pricing table path.
- The pricing cache is keyed by the data source, not only by time, so removing or changing
  the pricing table takes effect immediately instead of lingering for a TTL window.

## v0.12.0

- **Saturating classifier**: match counts are normalized per dimension (`n/(n+k)`) instead of
  being summed raw, and the aggregate score is now bounded and comparable across corpora.
  Repeating a keyword no longer scales the score — `"架构 架构 架构 …"` used to reach a v0
  score of 24 and now lands at ~0.51.
- **Tier boundaries re-expressed as relative thresholds** (`0.40` / `0.15`) instead of absolute
  point totals, so they can be calibrated from recorded outcomes.
- **Corroboration requirement kept for `Performance`**: `HARD` plus supporting evidence, never a
  bare keyword hit. Replayed against 306 recorded historical prompts, tier assignment matches
  the previous classifier on 305 of them (99.7%).
- **`classified` recorded per decision**, distinguishing a judged tier from the no-signal
  conservative fallback.
- **`scoreBreakdown` recorded per decision**, exposing the normalised contribution of each
  dimension for calibration.
- **`clsVersion` recorded per decision** so calibration never pools scores computed on different
  classifier scales.

## v0.11.0

- **Mid-thread upgrade**: three consecutive tool failures inside a turn upgrade the tier by one
  (max once per turn, with cooldown; manual gear untouched).
- **Sub-agent tiering**: `subagent` tasks are classified independently and receive the tier's
  anchor model; an explicit `model` argument is never overridden.
- Same-turn requeue after model-level rate-limit rotation (throttled, max once per turn).

## v0.10.x

- **Health gate level 3 — recent-error awareness**: models whose recent turn-error rate exceeds
  `recentErrorRateThreshold` (min `recentErrorMinSamples` samples in `recentErrorWindowSec`) are
  moved to the end of the viable list instead of being removed.
- Error classifier fix: English-form usage-window messages (`usage exceeds frequency limit …
  resets at …`) now parse the reset time and cool down until it; usage-window cap relaxed to 24 h.
- Pool ordering now documented as an operator-tunable anchor-first convention.

## v0.9.0

- **Turn-level outcome log** (`outcome-log.jsonl`): one row per agent turn joined to the decision
  via `decisionId` — first queryable "actual success rate per tier/model" data.
- **Offline calibration tool** `tools/router_calibrate.py` (read-only; sample-floor aware; no
  online self-adaptation by design).

## v0.8.x

- Audit-log rotation: `decision-log.jsonl` capped at 8 MB with one-generation `.1` retention.
- Failover generalized from a fixed model pair to pool-order rotation (per-tier and cross-tier),
  with persistent per-model cooldowns.
- Lane preference (code / knowledge) inside the selected tier.
- Error feedback signals (model-level rate-limit cooldown windows, usage-window reset parsing).

## v0.6.0 — v0.7.x

- Two-gear state machine (auto / manual), active vs shadow mode.
- Rule-based tier classifier with signal scoring, time gate, account-level health probe,
  cascade downgrade, `/router` command surface.

## v0.5.x — v0.4.x

- First-message switching with failure fallback and decision logging.
- Shadow-mode observation (record intended switches without applying them).
