# Changelog

Notable changes, newest first.

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
