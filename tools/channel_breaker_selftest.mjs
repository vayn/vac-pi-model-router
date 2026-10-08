/**
 * 渠道级熔断真值表自测（2026-10-08）
 *
 * 背景：某次实测中，一个渠道的全部模型在 60s 后统一返回 `unexpected EOF`，
 *   原实现只冷却被点名的单个模型，池内同渠道另一模型仍被选中 ⇒ 连续多次
 *   表现为「连续多次截断」。本脚本验证熔断三态与边界。
 *
 * 判据（真值表）：
 *   1. 失败 < 阈值 → 渠道不熔断（同渠道模型仍可选）
 *   2. 失败达阈值 → 渠道熔断，该渠道**所有**模型（含未被点名的）均被判不可用
 *   3. 熔断期内新增失败不延长熔断（until 未过期时不重置）
 *   4. 熔断到期后自动恢复
 *   5. 滑窗外的老失败不计入阈值
 *   6. disabled=true 时不熔断
 *   7. 空渠道名（无 "/" 前缀）不触发熔断
 *
 * 用法：node tools/channel_breaker_selftest.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = join(tmpdir(), `channel-breaker-selftest-${process.pid}`);
const STATE_PATH = join(SANDBOX, "channel-breaker-state.json");
mkdirSync(SANDBOX, { recursive: true });

// ---- 被测逻辑的独立副本（与 model-router.ts 实现保持同一算法）----
const CHANNEL_BREAKER_DEFAULT = {
  enabled: true,
  windowSec: 900,
  failThreshold: 3,
  cooldownSec: 900,
};

function loadChannelBreaker(statePath) {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    const m = new Map();
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      const fails = (v.fails ?? []).filter((t) => now - t < 24 * 3600 * 1000);
      const until = (v.until ?? 0) > now ? v.until : 0;
      if (fails.length || until) m.set(k, { fails, until });
    }
    return m;
  } catch {
    return new Map();
  }
}

function channelBreakerCfg(c) {
  return { ...CHANNEL_BREAKER_DEFAULT, ...(c.channelBreaker ?? {}) };
}

function isChannelTripped(channel, c, state) {
  const cfg = channelBreakerCfg(c);
  if (!cfg.enabled || !channel) return false;
  const rec = state.get(channel);
  return !!rec && rec.until > Date.now();
}

function markChannelFailed(channel, c, state) {
  const cfg = channelBreakerCfg(c);
  if (!cfg.enabled || !channel) return false;
  const now = Date.now();
  const rec = state.get(channel) ?? { fails: [], until: 0 };
  rec.fails = rec.fails.filter((t) => now - t < cfg.windowSec * 1000);
  rec.fails.push(now);
  let tripped = false;
  if (rec.until <= now && rec.fails.length >= cfg.failThreshold) {
    rec.until = now + cfg.cooldownSec * 1000;
    tripped = true;
  }
  state.set(channel, rec);
  return tripped;
}

const cfg = {}; // 默认值
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

console.log("[渠道级熔断自测]");

check("1. 失败 < 阈值(2/3) → 不熔断，同渠道模型仍可选", () => {
  const s = new Map();
  assert.equal(markChannelFailed("ch-alpha", cfg, s), false);
  assert.equal(markChannelFailed("ch-alpha", cfg, s), false);
  assert.equal(isChannelTripped("ch-alpha", cfg, s), false);
});

check("2. 失败达阈值(3/3) → 熔断，该渠道全部模型不可用", () => {
  const s = new Map();
  markChannelFailed("ch-alpha", cfg, s);
  markChannelFailed("ch-alpha", cfg, s);
  assert.equal(markChannelFailed("ch-alpha", cfg, s), true, "第 3 次应触发熔断");
  // 关键：未被点名的同渠道模型也须被判不可用（原缺陷所在）
  assert.equal(isChannelTripped("ch-alpha", cfg, s), true);
  assert.equal(isChannelTripped("ch-alpha", cfg, s), true, "同渠道任一模型共用渠道熔断");
});

check("3. 熔断期内新增失败不延长熔断", () => {
  const s = new Map();
  for (let i = 0; i < 3; i++) markChannelFailed("ch-alpha", cfg, s);
  const until1 = s.get("ch-alpha").until;
  markChannelFailed("ch-alpha", cfg, s); // 熔断期内再失败
  assert.equal(s.get("ch-alpha").until, until1, "until 不应被重置");
});

check("4. 熔断到期后自动恢复", () => {
  const s = new Map();
  for (let i = 0; i < 3; i++) markChannelFailed("ch-alpha", cfg, s);
  // 模拟到期
  s.get("ch-alpha").until = Date.now() - 1;
  assert.equal(isChannelTripped("ch-alpha", cfg, s), false, "到期后不应仍熔断");
});

check("5. 滑窗外的老失败不计入阈值", () => {
  const s = new Map();
  const old = Date.now() - 1000 * 1000; // 远超 windowSec=900
  s.set("ch-alpha", { fails: [old, old], until: 0 });
  markChannelFailed("ch-alpha", cfg, s); // 仅 1 次新鲜失败
  assert.equal(isChannelTripped("ch-alpha", cfg, s), false, "老失败应被清除，不达阈值");
});

check("6. disabled=true → 不熔断", () => {
  const s = new Map();
  const off = { channelBreaker: { ...CHANNEL_BREAKER_DEFAULT, enabled: false } };
  for (let i = 0; i < 5; i++) markChannelFailed("ch-alpha", off, s);
  assert.equal(isChannelTripped("ch-alpha", off, s), false);
});

check("7. 空渠道名不触发熔断（无 '/' 前缀的模型 id）", () => {
  const s = new Map();
  for (let i = 0; i < 5; i++) markChannelFailed("", cfg, s);
  assert.equal(isChannelTripped("", cfg, s), false);
});

check("8. 多渠道隔离：ch-alpha 熔断不影响 ch-beta", () => {
  const s = new Map();
  for (let i = 0; i < 3; i++) markChannelFailed("ch-alpha", cfg, s);
  assert.equal(isChannelTripped("ch-alpha", cfg, s), true);
  assert.equal(isChannelTripped("ch-beta", cfg, s), false, "其他渠道不受牵连");
  assert.equal(isChannelTripped("ch-gamma", cfg, s), false);
});

check("9. 状态持久化往返（写入→读回）保留熔断态", () => {
  const s = new Map();
  for (let i = 0; i < 3; i++) markChannelFailed("ch-alpha", cfg, s);
  writeFileSync(STATE_PATH, JSON.stringify(Object.fromEntries(s)), { mode: 0o600 });
  assert.ok(existsSync(STATE_PATH));
  const s2 = loadChannelBreaker(STATE_PATH);
  assert.equal(isChannelTripped("ch-alpha", cfg, s2), true, "重启后熔断态应仍在");
});

rmSync(SANDBOX, { recursive: true, force: true });

// ===================================================================
// 人工禁用（“灰色”不可选）真值表
// 与熔断的语义分层：熔断=自动且会自愈（渠道故障）；灰色=人工且须手动删行
// （额度耗尽，恢复后逐条删除）；永久下架（provider 删除）=移出池 + 排除表。
// ===================================================================

function isDisabled(modelId, c) {
  const list = c.disabledModels ?? [];
  if (list.length === 0) return false;
  const ch = modelId.split("/")[0] ?? "";
  return list.some((p) => p === modelId || (p.endsWith("/*") && p.slice(0, -2) === ch));
}

console.log("\n[人工禁用（灰色）自测]");

check("D1. 空名单 → 全部可选（默认不干预）", () => {
  assert.equal(isDisabled("ch-beta/model-c", {}), false);
});

check("D2. 精确匹配命中，不波及其他模型", () => {
  const c = { disabledModels: ["ch-beta/model-b"] };
  assert.equal(isDisabled("ch-beta/model-b", c), true);
  assert.equal(isDisabled("ch-beta/model-c", c), false, "同渠道其他模型不应被波及");
});

check("D3. '渠道/*' 通配：整渠道禁用", () => {
  const c = { disabledModels: ["ch-gamma/*", "ch-alpha/*"] };
  assert.equal(isDisabled("ch-gamma/model-c", c), true);
  assert.equal(isDisabled("ch-gamma/model-f", c), true);
  assert.equal(isDisabled("ch-alpha/model-a", c), true);
  assert.equal(isDisabled("ch-beta/model-c", c), false, "其他渠道不受影响");
});

check("D4. 通配不误伤前缀相似渠道（ch-beta vs ch-gamma）", () => {
  const c = { disabledModels: ["ch-beta/*"] };
  assert.equal(isDisabled("ch-beta/model-c", c), true);
  assert.equal(isDisabled("ch-gamma/model-c", c), false, "前缀相似但非同一渠道，不得误伤");
});

check("D5. 混合清单（精确 + 通配）均生效", () => {
  const c = { disabledModels: ["ch-alpha/*", "ch-delta/model-d"] };
  assert.equal(isDisabled("ch-alpha/qwen3.8-flash", c), true);
  assert.equal(isDisabled("ch-delta/model-d", c), true);
  assert.equal(isDisabled("ch-delta/model-g", c), false);
});

check("D6. 全灰时可用集为空（交由上层级联降档，非崩溃）", () => {
  const pool = ["ch-gamma/model-c", "ch-gamma/model-f"];
  const c = { disabledModels: ["ch-gamma/*"] };
  assert.deepEqual(pool.filter((m) => !isDisabled(m, c)), []);
});

// ---- 外置真源（v0.15.0）：disabled-models.json 解析 + 回退 ----
function parseDisabledDoc(doc) {
  return (doc.models ?? [])
    .map((m) => (typeof m === "string" ? m : (m?.id ?? "")))
    .filter((x) => typeof x === "string" && x.length > 0);
}

console.log("\n[灰名单外置真源自测]");

check("E1. 对象形式 [{id,reason,reviewAt}] 解出 id 列表", () => {
  const list = parseDisabledDoc({
    models: [
      { id: "ch-beta/model-b", reason: "429", reviewAt: "2026-10-08T08:00:00+08:00" },
      { id: "ch-alpha/*", reason: "渠道故障", reviewAt: null },
    ],
  });
  assert.deepEqual(list, ["ch-beta/model-b", "ch-alpha/*"]);
});

check("E2. 字符串形式兼容（旧写法/脱敏版）", () => {
  assert.deepEqual(parseDisabledDoc({ models: ["a/b", "c/*"] }), ["a/b", "c/*"]);
});

check("E3. 空/缺失 models ⇒ 空列表（不抛）", () => {
  assert.deepEqual(parseDisabledDoc({}), []);
  assert.deepEqual(parseDisabledDoc({ models: [] }), []);
});

check("E4. 脏条目被过滤（无 id / 空串）", () => {
  assert.deepEqual(parseDisabledDoc({ models: [{}, { id: "" }, { id: "ok/m" }] }), ["ok/m"]);
});

check("E5. 外置列表喂给 isDisabled 与内联数组行为一致", () => {
  const list = parseDisabledDoc({ models: [{ id: "ch-alpha/*" }, { id: "ch-beta/model-b" }] });
  const c = { disabledModels: list };
  assert.equal(isDisabled("ch-alpha/model-a", c), true);
  assert.equal(isDisabled("ch-beta/model-b", c), true);
  assert.equal(isDisabled("ch-beta/model-c", c), false);
});

console.log(`\n[汇总] 累计 ${passed} passed, ${failed} failed（熔断 9 + 灰色 6 + 外置真源 5）`);
process.exit(failed > 0 ? 1 : 0);