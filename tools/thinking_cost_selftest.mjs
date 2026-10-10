/**
 * Thinking-level truth-table self-test (cost axis × tier axis, v0.16.0 + v0.16.1)
 *
 * Rule under test: the router sets the thinking level itself — free models are capped at
 * `minimal`, paid models default to reasoning **off**. Implemented as "stricter of two axes"
 * (tier axis as the ceiling × cost axis as the default), applied on router-initiated switches
 * **and** on `session_start` / `model_select` (the "default" semantics must cover the startup
 * model and a manual `/model`, otherwise no level is ever applied on a day without a switch).
 *
 * v0.16.1: the cost axis engages **only when cost data exists** (a non-empty explicit list, or a
 * readable pricing table). Without it the router cannot tell free from paid, so it falls back to
 * the tier axis instead of treating "unknown" as "paid" — otherwise a deployment that never
 * configured a pricing source would have every model's reasoning silently turned off.
 *
 * Subject under test: the **real extension source**, imported by its named exports (the
 * "test surface" at the end of extensions/model-router.ts). No second copy of the logic: a copy
 * lets "tests green, source wrong" coexist indefinitely.
 *
 * Truth table:
 *   A. cost axis × tier axis, stricter wins
 *      1. paid + Balanced (ceiling medium)  → off
 *      2. paid + Performance (ceiling high) → off (no flagship exception)
 *      3. paid + Fast (ceiling minimal)      → off
 *      4. free + Balanced                    → minimal (a ceiling, not an assignment)
 *      5. free + Fast                        → minimal
 *      6. free + out-of-pool (tier=null)     → minimal (cost axis alone decides)
 *      7. paid + out-of-pool                 → off
 *   B. cost source and conservative defaults
 *      8. rate=0 row hit (pool form)                  → free
 *      9. row hit by resolved provider/id form too    → free (two-form lookup)
 *     10. explicit pricing.freeModels hit             → free
 *     11. no cost data at all                         → cost axis inert, tier axis (v0.16.1)
 *     11b. pricing file configured but unreadable      → inert, not "everything off"
 *     11c. cost data present but model not listed      → still paid → off
 *     11d. explicit list non-empty (no pricing file)   → cost axis engages (a list is data)
 *     12. every pool entry lands in {off, minimal}     → core invariant: nobody reaches medium+
 *            (checked against $MODEL_ROUTER_PRICING when set; skipped with a note otherwise)
 *   C. application and exemptions
 *     13. settings.modelThinkingLevels entry → yield (returns null and never calls
 *         setThinkingLevel at all, 13b) — paid models included: that entry is the only
 *         stable exemption
 *     14. no explicit entry → paid flagship gets off (14b asserts the argument passed)
 *     15. current level already equal → no write (15b idempotence: session_start and
 *         model_select must not fight); 15c/15d a free model at medium/xhigh is pressed
 *         back to minimal (ceiling semantics)
 *     16. setThinkingLevel throws → null, never bubbles (nothing may break the session)
 *   D. rollback and form helpers
 *     17. thinkingCost.enabled=false → pure v0.13.0 tier behaviour
 *     18. poolIdOf strips the provider segment; 19. no slash → unchanged
 *     20-24. stricterLevel: off<minimal<low<medium<high<xhigh<max; unknown yields to known
 *
 * Usage: node --experimental-strip-types tools/thinking_cost_selftest.mjs
 *   (needs node >= 22 for TypeScript type stripping; on node 20 use tsx or point at a newer node)
 * Exit code: 0 = all passed; 1 = assertion failures
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- isolation: state dir and agent dir always point at a temp path (never touch real logs/config) ----
const SANDBOX = join(tmpdir(), `thinking-cost-selftest-${process.pid}`);
mkdirSync(SANDBOX, { recursive: true });
const STATE = join(SANDBOX, "state");
const AGENT = join(SANDBOX, "agent");
mkdirSync(STATE, { recursive: true });
mkdirSync(AGENT, { recursive: true });
process.env.MODEL_ROUTER_STATE_DIR = STATE;
process.env.PI_CODING_AGENT_DIR = AGENT;

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "model-router.ts");
const mod = await import(SRC);
const {
  DEFAULTS,
  THINK_ORDER,
  poolIdOf,
  isFreeInPricing,
  costKnowledge,
  costDataAvailable,
  desiredThinkingLevel,
  stricterLevel,
  applyThinkingTier,
} = mod;

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (got === want) {
    pass += 1;
    console.log(`  ✓ ${name} → ${JSON.stringify(got)}`);
  } else {
    fails.push(`${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    console.log(`  ✗ ${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}

function pricingFixture(name, rows) {
  // a string is written verbatim (used to build the "path present, content broken" case)
  const p = join(SANDBOX, `pricing-${name}.json`);
  writeFileSync(p, typeof rows === "string" ? rows : JSON.stringify({ models: rows }), "utf8");
  return p;
}
function cfgWith(pricingFile, extra = {}) {
  return {
    ...DEFAULTS,
    pricing: { file: pricingFile, freeModels: [] },
    ...extra,
  };
}

// The default pool ships placeholders (`your-provider/…`); a gateway resolves them to
// `<gateway>/<channel>/<model>` — so the pool form is the entry minus the resolved provider.
const PRICING = pricingFixture("main", [
  { channel: "your-provider", model: "fast-model", rate: 0 }, // free Fast
  { channel: "your-provider", model: "cheap-backup", rate: 0.1 }, // paid Fast
  { channel: "your-provider", model: "balanced-model", rate: 0 }, // free Balanced
  { channel: "your-provider", model: "balanced-backup", rate: 0.11 }, // paid Balanced
  { channel: "your-provider", model: "strong-model", rate: 0.51 }, // paid Performance
  { channel: "your-provider", model: "extra-free", rate: 0 }, // free, out of pool
]);
// the freeSet cache is keyed by [list, path] ⇒ distinct file names invalidate it immediately
const C = cfgWith(PRICING);

console.log("A. cost axis × tier axis, stricter wins");
check("1 paid + Balanced (ceiling medium)", desiredThinkingLevel("gw/your-provider/balanced-backup", "Balanced", C), "off");
check("2 paid + Performance flagship, no exception", desiredThinkingLevel("gw/your-provider/strong-model", "Performance", C), "off");
check("3 paid + Fast (ceiling minimal)", desiredThinkingLevel("gw/your-provider/cheap-backup", "Fast", C), "off");
check("4 free + Balanced ⇒ capped at minimal", desiredThinkingLevel("gw/your-provider/balanced-model", "Balanced", C), "minimal");
check("5 free + Fast ⇒ minimal", desiredThinkingLevel("gw/your-provider/fast-model", "Fast", C), "minimal");
check("6 free + out-of-pool (tier=null)", desiredThinkingLevel("gw/your-provider/extra-free", null, C), "minimal");
check("7 paid + out-of-pool (tier=null)", desiredThinkingLevel("gw/some/unlisted-paid", null, C), "off");

console.log("B. cost source and conservative defaults");
check("8 pool form hits the table", isFreeInPricing("your-provider/fast-model", "gw/your-provider/fast-model", C), true);
check("9 resolved provider/id form hits too", isFreeInPricing("nope/unknown", "your-provider/fast-model", C), true);
const C_LIST = cfgWith(pricingFixture("empty", []), {});
C_LIST.pricing.freeModels = ["your-provider/balanced-backup"];
check("10 explicit free list hit", desiredThinkingLevel("gw/your-provider/balanced-backup", "Balanced", C_LIST), "minimal");
// v0.16.1: no cost data ⇒ the cost axis is **inert** (tier axis), "unknown" ≠ "paid"
const C_NONE = cfgWith(""); // no table, no list
check("11 no cost data ⇒ cost axis inert, tier axis applies", desiredThinkingLevel("gw/paid/any-model", "Balanced", C_NONE), "medium");
check("11a no cost data + Performance ⇒ tier axis high (not pressed to off)", desiredThinkingLevel("gw/paid/any-model", "Performance", C_NONE), "high");
check("11a2 no cost data + Fast ⇒ tier axis minimal", desiredThinkingLevel("gw/paid/any-model", "Fast", C_NONE), "minimal");
check("11a3 no cost data + out-of-pool (tier=null) ⇒ nothing to apply (null)", desiredThinkingLevel("gw/paid/any-model", null, C_NONE), null);
const C_BAD = cfgWith(pricingFixture("broken", "NOT-JSON")); // path present, content broken
check("11b unreadable pricing file ⇒ inert, tier axis applies", desiredThinkingLevel("gw/paid/any-model", "Balanced", C_BAD), "medium");
const C_MISSING = cfgWith("/nonexistent/pricing-cache.json"); // path configured, file absent
check("11b2 missing pricing file ⇒ inert, tier axis applies", desiredThinkingLevel("gw/paid/any-model", "Performance", C_MISSING), "high");
check("11c cost data present but model unlisted ⇒ still paid (off)", desiredThinkingLevel("gw/some/unlisted-paid", "Balanced", C), "off");
check("11d non-empty list, no pricing file ⇒ cost axis engages", desiredThinkingLevel("gw/your-provider/cheap-backup", "Fast", C_LIST), "off");
check("11d2 non-empty list: listed model capped at minimal", desiredThinkingLevel("gw/your-provider/balanced-backup", "Balanced", C_LIST), "minimal");
check("11e costDataAvailable: no table, no list = false", costDataAvailable(C_NONE), false);
check("11e2 costDataAvailable: broken table = false", costDataAvailable(C_BAD), false);
check("11e3 costDataAvailable: non-empty list = true", costDataAvailable(C_LIST), true);
check("11e4 costDataAvailable: table present = true", costDataAvailable(C), true);
const K1 = costKnowledge(C_LIST); // one snapshot: available and free must agree
check("11e5 costKnowledge is single-source", `${K1.available}/${K1.free.has("your-provider/balanced-backup")}/${K1.free.size}`, "true/true/1");
// 12 whole-pool invariant against a real pricing table, when one is configured
const LIVE_PRICING = process.env.MODEL_ROUTER_PRICING || "";
if (LIVE_PRICING && existsSync(LIVE_PRICING)) {
  const CL = cfgWith(LIVE_PRICING);
  const out = [];
  for (const tier of Object.keys(DEFAULTS.pool)) {
    for (const m of DEFAULTS.pool[tier]) {
      const parsed = `gw/${m}`;
      const lvl = desiredThinkingLevel(parsed, tier, CL);
      if (lvl !== "off" && lvl !== "minimal") out.push(`${tier}/${m}=${lvl}`);
    }
  }
  check("12 every pool entry ∈ {off,minimal} (live pricing table)", out.join(","), "");
} else {
  console.log("  － 12 skipped: no MODEL_ROUTER_PRICING table available (not a failure)");
}

console.log("C. application and exemptions");
function fakePi(settings, current, throwOnSet = false) {
  const calls = [];
  return {
    calls,
    getSettings: () => settings,
    getThinkingLevel: () => current,
    setThinkingLevel: (l) => {
      if (throwOnSet) throw new Error("boom");
      calls.push(l);
    },
  };
}
const p1 = fakePi({ modelThinkingLevels: { "gw/your-provider/balanced-backup": "xhigh" } }, "xhigh");
check("13 explicit per-model setting wins ⇒ yield (null)", applyThinkingTier(p1, "gw/your-provider/balanced-backup", "Balanced", C), null);
check("13b setThinkingLevel never called when yielding", p1.calls.length, 0);
const p2 = fakePi({}, "medium");
check("14 no explicit setting ⇒ paid flagship set to off", applyThinkingTier(p2, "gw/your-provider/strong-model", "Performance", C), "off");
check("14b setThinkingLevel argument", p2.calls.join(","), "off");
const p3 = fakePi({}, "off");
check("15 already at target ⇒ no rewrite", applyThinkingTier(p3, "gw/your-provider/strong-model", "Performance", C), null);
check("15b no call when idempotent", p3.calls.length, 0);
const p5 = fakePi({}, "medium");
check("15c free Balanced ⇒ minimal (ceiling)", applyThinkingTier(p5, "gw/your-provider/balanced-model", "Balanced", C), "minimal");
const p6 = fakePi({}, "xhigh");
check("15d free and currently above the ceiling ⇒ pressed back to minimal", applyThinkingTier(p6, "gw/your-provider/balanced-model", "Balanced", C), "minimal");
const p4 = fakePi({}, "medium", true);
check("16 setThinkingLevel throws ⇒ null, no bubble", applyThinkingTier(p4, "gw/your-provider/balanced-model", "Balanced", C), null);

console.log("D. rollback and form helpers");
check("0a DEFAULTS.thinkingCost.enabled (cost axis on by default)", DEFAULTS.thinkingCost.enabled, true);
check("0b DEFAULTS.thinkingCost.freeMax (free ceiling)", DEFAULTS.thinkingCost.freeMax, "minimal");
check("0c DEFAULTS.thinkingCost.paid (paid default)", DEFAULTS.thinkingCost.paid, "off");
check("0d DEFAULTS.thinkingTier.enabled (tier ceiling still on)", DEFAULTS.thinkingTier.enabled, true);
const C_OFF = cfgWith(PRICING, { thinkingCost: { enabled: false, freeMax: "minimal", paid: "off" } });
check("17 thinkingCost.enabled=false ⇒ back to pure tier axis", desiredThinkingLevel("gw/your-provider/balanced-model", "Balanced", C_OFF), "medium");
check("18 poolIdOf strips the provider segment", poolIdOf("gw/your-provider/fast-model"), "your-provider/fast-model");
check("19 poolIdOf without a slash is unchanged", poolIdOf("gpt-5"), "gpt-5");
check("20 THINK_ORDER first = off", THINK_ORDER[0], "off");
check("21 stricter(off,medium)", stricterLevel("off", "medium"), "off");
check("22 stricter(medium,minimal)", stricterLevel("medium", "minimal"), "minimal");
check("23 stricter(high,xhigh)", stricterLevel("high", "xhigh"), "high");
check("24 unknown yields to known", stricterLevel("ultra", "minimal"), "minimal");

console.log("E. handler wiring (runs the real session_start / model_select code paths)");
// Why this group: pure functions can be green while the handler never calls them — then the
// "default" still does nothing in production. v0.16.0 changed *when* levels are applied, so the
// hook bodies themselves must be exercised: take the real default export, feed it a recording
// fake ExtensionAPI, trigger session_start / model_select, assert what setThinkingLevel got.
{
  // raise the config: write a temp model-router.config.json (pricing → fixture, rest DEFAULTS)
  const cfgPath = join(AGENT, "model-router.config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({ pricing: { file: PRICING, freeModels: [] }, mode: "active" }),
    "utf8",
  );
  function harnessPi(initialLevel, settings = {}) {
    const handlers = {};
    const sets = [];
    let current = initialLevel;
    const pi = {
      on: (ev, h) => {
        handlers[ev] = h;
      },
      registerCommand: () => {},
      registerFlag: () => {},
      getSettings: () => settings,
      getThinkingLevel: () => current,
      setThinkingLevel: (l) => {
        sets.push(l);
        auditWrites += 1;
        current = l;
      },
      setModel: async () => true,
      getModel: () => undefined,
    };
    mod.default(pi);
    return { pi, handlers, sets, getCurrent: () => current };
  }
  const mkCtx = (provider, id) => ({ model: { provider, id }, hasUI: false, ui: { notify() {} } });
  // write counter tied to E9: every effective write must leave one thinking_default record
  let auditWrites = 0;

  // E1 startup on a paid Performance model (rate 0.51) ⇒ must be set to off
  let h = harnessPi("high");
  await h.handlers.session_start({ type: "session_start", reason: "startup" }, mkCtx("gw", "your-provider/strong-model"));
  check("E1 session_start paid flagship → off", h.getCurrent(), "off");
  check("E1b write count (no duplicates)", h.sets.join(","), "off");

  // E2 startup on a free Balanced model ⇒ capped at minimal (the old axis would give medium)
  h = harnessPi("medium");
  await h.handlers.session_start({ type: "session_start", reason: "startup" }, mkCtx("gw", "your-provider/balanced-model"));
  check("E2 session_start free Balanced → minimal (capped)", h.getCurrent(), "minimal");

  // E3 manual /model onto a paid model (model_select path) ⇒ off as well
  h = harnessPi("xhigh");
  h.handlers.model_select(
    { type: "model_select", model: { provider: "gw", id: "your-provider/strong-model" }, previousModel: undefined, source: "command" },
    mkCtx("gw", "your-provider/strong-model"),
  );
  check("E3 model_select paid → off", h.getCurrent(), "off");

  // E4 the two hooks must not fight: session_start then model_select for the same model ⇒ one write
  h = harnessPi("high");
  await h.handlers.session_start({ type: "session_start", reason: "startup" }, mkCtx("gw", "your-provider/strong-model"));
  h.handlers.model_select(
    { type: "model_select", model: { provider: "gw", id: "your-provider/strong-model" }, previousModel: undefined, source: "rpc" },
    mkCtx("gw", "your-provider/strong-model"),
  );
  check("E4 same model through both hooks ⇒ one write", h.sets.length, 1);

  // E5 an explicit per-model setting still wins (the only stable exemption): neither hook touches it
  h = harnessPi("xhigh", { modelThinkingLevels: { "gw/your-provider/strong-model": "xhigh" } });
  await h.handlers.session_start({ type: "session_start", reason: "startup" }, mkCtx("gw", "your-provider/strong-model"));
  h.handlers.model_select(
    { type: "model_select", model: { provider: "gw", id: "your-provider/strong-model" }, previousModel: undefined, source: "command" },
    mkCtx("gw", "your-provider/strong-model"),
  );
  check("E5 explicit modelThinkingLevels ⇒ zero writes (yields)", h.sets.length, 0);
  check("E5b the user's level survives", h.getCurrent(), "xhigh");

  // E6 manual-gear semantics intact: a manual /model after a user message still enters manual
  h = harnessPi("medium");
  await h.handlers.session_start({ type: "session_start", reason: "resume" }, mkCtx("gw", "your-provider/balanced-model"));
  h.handlers.model_select(
    { type: "model_select", model: { provider: "gw", id: "your-provider/balanced-backup" }, previousModel: undefined, source: "command" },
    mkCtx("gw", "your-provider/balanced-backup"),
  );
  check("E6 paid manual switch → off (coexists with manual gear)", h.getCurrent(), "off");

  // E7 out-of-pool models: free → minimal, paid → off
  h = harnessPi("medium");
  await h.handlers.session_start({ type: "session_start", reason: "startup" }, mkCtx("gw", "your-provider/extra-free"));
  check("E7 out-of-pool free ⇒ minimal", h.getCurrent(), "minimal");
  h = harnessPi("medium");
  await h.handlers.session_start({ type: "session_start", reason: "startup" }, mkCtx("anthropic", "claude-x"));
  check("E8 direct provider model (unlisted) → off (conservative)", h.getCurrent(), "off");

  // E9 the thinking_default audit records match the writes one-for-one (temp state dir, real logs untouched)
  const logFile = join(STATE, "decision-log.jsonl");
  const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean) : [];
  const td = lines.map((l) => JSON.parse(l)).filter((r) => r.type === "thinking_default");
  check("E9 audit records ≡ actual writes (extra/missing both fail)", `${td.length}/${auditWrites}`, `${auditWrites}/${auditWrites}`);
  check("E9b records carry the pool form and the free flag", typeof td[0]?.poolModel === "string" && typeof td[0]?.free === "boolean", true);
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\nResult: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.map((f) => `  ✗ ${f}`).join("\n"));
  process.exit(1);
}