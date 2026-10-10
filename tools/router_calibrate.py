#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""router_calibrate.py —— model-router 分档/候选池的 outcome 校准报告（离线，只读）

设计依据：用真实 outcome 数据（回合成功/失败）校准分档先验，替代纯规则拍脑袋——
      「规则/阈值调整必须有数据依据并留记录」。

设计原则（与在线自适应相反）：
  · **只读不改**——本脚本不写任何运行态文件，更不自动调整决策行为；
  · **出报告 + 人工裁定**——先验分档与实测不符的项标 ⚠，由人确认后改 DEFAULTS 常量；
    理由：早期样本少（n<30）时在线自适应会被噪声主导，且决策行为随历史漂移不可解释。

数据源（均为本地只读）：
  ~/.local/state/model-router/decision-log.jsonl  决策明细（含 decisionId / tier / rule / signals）
  ~/.local/state/model-router/outcome-log.jsonl   回合 outcome（v0.9.0 起）
  ~/.local/state/model-router/error-state.json    模型级限流冷却（P2-1）

用法：
  python3 tools/router_calibrate.py                # 全量报告
  python3 tools/router_calibrate.py --days 7       # 只看最近 7 天
  python3 tools/router_calibrate.py --min-n 30     # 样本下限（低于则标「样本不足」，不给结论）
  python3 tools/router_calibrate.py --json         # 机器可读输出

退出码：0=正常；2=数据不可读（无 outcome-log 或为空）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

STATE_DIR = os.environ.get("MODEL_ROUTER_STATE_DIR") or os.path.expanduser(
    "~/.local/state/model-router"
)
DECISION_LOG = os.path.join(STATE_DIR, "decision-log.jsonl")
OUTCOME_LOG = os.path.join(STATE_DIR, "outcome-log.jsonl")
ERROR_STATE = os.path.join(STATE_DIR, "error-state.json")

WARN = "⚠"
OKMARK = "✓"


def _read_jsonl(path: str) -> list[dict]:
    out: list[dict] = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue  # 坏行跳过，不因单行阻断报告
    except FileNotFoundError:
        pass
    return out


def _parse_ts(v) -> datetime | None:
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except Exception:
        return None


def _pct(n: int, d: int) -> str:
    return f"{n / d * 100:.1f}%" if d else "—"


def load(days: int | None, ):
    dec = _read_jsonl(DECISION_LOG)
    out = _read_jsonl(OUTCOME_LOG)
    if days:
        cut = datetime.now(timezone.utc) - timedelta(days=days)
        dec = [r for r in dec if (_parse_ts(r.get("ts")) or cut) >= cut]
        out = [r for r in out if (_parse_ts(r.get("ts")) or cut) >= cut]
    return dec, out


def main() -> int:
    ap = argparse.ArgumentParser(description="model-router outcome 校准报告（离线只读）")
    ap.add_argument("--days", type=int, default=None, help="只看最近 N 天（默认全量）")
    ap.add_argument("--min-n", type=int, default=30, help="样本下限，低于则不给结论（默认 30）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    dec, out = load(args.days)

    # outcome 与决策按 decisionId 关联
    dec_by_id = {r["decisionId"]: r for r in dec if r.get("decisionId")}
    matched = [o for o in out if o.get("decisionId") in dec_by_id]
    unmatched = len(out) - len(matched)

    if not out:
        msg = (
            f"outcome-log 为空或不存在：{OUTCOME_LOG}\n"
            f"  说明：v0.9.0 起才落盘回合 outcome。若刚升级，需在**新会话**产生若干回合后复用本报告。\n"
            f"  现有 decision-log：{len(dec)} 条（无 outcome 可关联）"
        )
        if args.json:
            print(json.dumps({"error": "no_outcome_data", "decisionLog": len(dec)}, ensure_ascii=False, indent=2))
        else:
            print(msg)
        return 2

    # ---- 聚合 ----
    def agg() -> dict:
        return {"n": 0, "err": 0, "req": 0, "rl": 0, "lat": []}

    by_model: dict[str, dict] = defaultdict(agg)
    by_tier: dict[str, dict] = defaultdict(agg)
    by_rule: dict[str, dict] = defaultdict(agg)
    combos: dict[tuple, dict] = defaultdict(agg)

    for o in matched:
        d = dec_by_id[o["decisionId"]]
        m = o.get("model") or d.get("currentModel") or "?"
        tier = o.get("tier") or d.get("tier") or "?"
        rule = d.get("rule") or "?"
        is_err = o.get("turnResult") == "error"
        is_req = bool(o.get("neededRequeue"))
        is_rl = o.get("errorKind") == "rate_limit"
        lat = o.get("latencyMs")
        for bucket, key in ((by_model, m), (by_tier, tier), (by_rule, rule), (combos, (tier, m))):
            b = bucket[key]
            b["n"] += 1
            b["err"] += is_err
            b["req"] += is_req
            b["rl"] += is_rl
            if isinstance(lat, (int, float)):
                b["lat"].append(lat)

    def rows(bucket: dict) -> list[dict]:
        res = []
        for k, b in sorted(bucket.items(), key=lambda x: -x[1]["n"]):
            lat = b["lat"]
            res.append(
                {
                    "key": k if isinstance(k, str) else "/".join(k),
                    "n": b["n"],
                    "okRate": round((b["n"] - b["err"]) / b["n"] * 100, 1) if b["n"] else None,
                    "errRate": round(b["err"] / b["n"] * 100, 1) if b["n"] else None,
                    "requeueRate": round(b["req"] / b["n"] * 100, 1) if b["n"] else None,
                    "rateLimitRate": round(b["rl"] / b["n"] * 100, 1) if b["n"] else None,
                    "p50ms": sorted(lat)[len(lat) // 2] if lat else None,
                }
            )
        return res

    report = {
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        "windowDays": args.days,
        "minN": args.min_n,
        "source": {
            "decisionLog": DECISION_LOG,
            "outcomeLog": OUTCOME_LOG,
            "decisionRecords": len(dec),
            "outcomeRecords": len(out),
            "matched": len(matched),
            "unmatchedOutcome": unmatched,
        },
        "byTier": rows(by_tier),
        "byModel": rows(by_model),
        "byRule": rows(by_rule),
        "byTierModel": rows(combos),
    }

    # ---- 校准建议（先验 vs 实测；仅对样本充足项给结论）----
    suggest: list[str] = []
    n = args.min_n
    for r in report["byModel"]:
        if r["n"] < n:
            continue
        if r["rateLimitRate"] is not None and r["rateLimitRate"] >= 10:
            suggest.append(
                f"{WARN} 模型 {r['key']} 限流率 {r['rateLimitRate']}%（n={r['n']}）"
                f" ⇒ 建议在候选池内降序，或考虑移出"
            )
        if r["errRate"] is not None and r["errRate"] >= 10:
            suggest.append(
                f"{WARN} 模型 {r['key']} 错误率 {r['errRate']}%（n={r['n']}）"
                f" ⇒ 建议复核其分档位置（先验分档可能与实测不符）"
            )
    for r in report["byTier"]:
        if r["n"] < n:
            continue
        if r["errRate"] is not None and r["errRate"] >= 8:
            suggest.append(
                f"{WARN} 档位 {r['key']} 错误率 {r['errRate']}%（n={r['n']}）"
                f" ⇒ 建议复核该档候选池构成"
            )
    report["suggestions"] = suggest

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    # ---- 人读报告 ----
    s = report["source"]
    print(f"== model-router outcome 校准报告（离线只读）==")
    print(f"  生成时间: {report['generated']}" + (f"  窗口: 最近 {args.days} 天" if args.days else "  窗口: 全量"))
    print(f"  数据源  : decision-log {s['decisionRecords']} 条 / outcome-log {s['outcomeRecords']} 条")
    print(f"  已关联  : {s['matched']} 条" + (f"（未关联 {s['unmatchedOutcome']} 条，多为旧版无 decisionId 的记录）" if s["unmatchedOutcome"] else ""))
    print(f"  样本下限: n >= {args.min_n}（低于此值不给结论）")
    print()

    def table(title: str, rows_: list[dict]) -> None:
        print(f"  ── {title} ──")
        if not rows_:
            print("     （无数据）")
        print(f"     {'项':<34} {'n':>5} {'成功':>7} {'错误':>7} {'重发':>7} {'限流':>7} {'p50(ms)':>8}")
        for r in rows_:
            flag = ""
            if r["n"] < args.min_n:
                flag = "  (样本不足)"
            print(
                f"     {str(r['key'])[:33]:<34} {r['n']:>5} "
                f"{str(r['okRate']) + '%':>7} "
                f"{str(r['errRate']) + '%':>7} {str(r['requeueRate']) + '%':>7} "
                f"{str(r['rateLimitRate']) + '%':>7} {str(r['p50ms'] or '—'):>8}{flag}"
            )
        print()

    table("按档位（Tier）", report["byTier"])
    table("按模型（Model）", report["byModel"])
    table("按分类规则（Rule）", report["byRule"])
    table("按 档×模型", report["byTierModel"])

    print("  ── 校准建议 ──")
    if suggest:
        for x in suggest:
            print(f"     {x}")
    else:
        print(f"     {OKMARK} 无非预期项（或样本不足，尚不足以给结论）")
    print()
    print("  提示：本报告**只读不改**。据建议修改 pi-agent/packages/model-router/extensions/")
    print("        model-router.ts 的 DEFAULTS 常量（池序/分档），改后请自行跑一次真实会话验证。")
    return 0


if __name__ == "__main__":
    sys.exit(main())