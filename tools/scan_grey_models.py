#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scan_grey_models.py —— 灰名单恢复巡检（只读，半人工核实）

设计动机：
    「给 /router 加一个扫描灰色清单中 model 是否恢复的命令，比如 [模型 X] 是 8 点
     恢复额度，如果到点就巡查确认，没到点就自动忽略，实现半人工核实」

## 为什么需要「未到点自动忽略」

灰名单条目的 `reviewAt` 是**上游自己声明的额度重置时刻**（典型来源：429 响应体里
写明的「将在 N 点重置限流」）。在到点之前探测**必然失败且无信息量**，只会浪费配额
与等待时间。故本工具的第一行为是**时点筛选**：未到点的条目直接跳过、**零网络请求**。

    · reviewAt 到点      ⇒ 探测（具备判定价值）
    · reviewAt 未到点    ⇒ 跳过（not_due，零请求）  ← 核心行为
    · reviewAt 缺失/非法 ⇒ 视为可随时复检（fail-open，不静默漏检）
    · --all              ⇒ 忽略时点，强制全量

## 为什么是「半人工」

可用性是**随机量**而非布尔属性：同一分钟内同一模型可能既 429 又 200。因此：

    · 判据用**成功率**而非单发采样——只要有一次 200 就绝不判死；
    · 本工具**只给出「可从灰名单移除」的建议，不自动改文件**。
      自动摘除会把一次偶发成功放大成配置变更——这就是「半人工」的本意：
      机器负责筛选与取证，人负责决定。

## 判定语义

与候选池健康巡检**同一套语义**（成功率判定、只对确定性失败判死），故两者结论可比：

    ok / slow / flaky / tool_gap  ⇒ 已恢复
    429 全败                       ⇒ suspended（限流，不判死）
    确定性 4xx/5xx（非 429）全败   ⇒ unavailable（未恢复）
    超时/网络全败                  ⇒ transient（未恢复，但重试无收益故早退）

## 配置

    MODEL_ROUTER_GATEWAY_URL   网关基址（默认 http://127.0.0.1:7863）
    MODEL_ROUTER_GATEWAY_KEY   网关 API key；未设则读 MODEL_ROUTER_GATEWAY_CONFIG 指定的配置文件
    MODEL_ROUTER_GATEWAY_CONFIG  网关 config.json 路径（含 api_key）

## 用法

    python3 scan_grey_models.py                # 按 reviewAt 筛选后探测
    python3 scan_grey_models.py --list         # 只列时点状态（零请求）
    python3 scan_grey_models.py --all          # 忽略时点，强制全量
    python3 scan_grey_models.py --self-test    # 时点判定真值表自测（零网络）

退出码：0 = 无已恢复项或全未到点 | 10 = 存在已恢复项，建议人工移除 | 2 = 取数/配置失败
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

GATEWAY = os.environ.get("MODEL_ROUTER_GATEWAY_URL", "http://127.0.0.1:7863")
DEFAULT_CONFIG = os.environ.get("MODEL_ROUTER_GATEWAY_CONFIG", "")
HERE = Path(__file__).resolve().parent
# 灰名单真源：默认与本工具同目录（开源版布局）；可用 --file 覆盖。
GREY_FILE = HERE / "disabled-models.json"

SLOW_MS = 8000
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_time",
            "description": "Get current time",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    }
]


def die(msg: str, code: int = 2) -> "int":
    print(f"[scan-grey] 失败：{msg}")
    return code


def load_secrets(config_path: str) -> tuple[str, str]:
    """读网关 api_key。优先环境变量 MODEL_ROUTER_GATEWAY_KEY；否则读配置文件。"""
    env_key = os.environ.get("MODEL_ROUTER_GATEWAY_KEY")
    if env_key:
        return env_key, ""
    if not config_path:
        raise RuntimeError("未设置 MODEL_ROUTER_GATEWAY_KEY，也未提供 MODEL_ROUTER_GATEWAY_CONFIG 配置文件路径")
    doc = json.loads(Path(config_path).read_text(encoding="utf-8"))
    return str(doc.get("api_key") or ""), str(doc.get("admin_password") or "")


def load_grey(path: Path) -> list[dict]:
    """读灰名单；兼容 models 为字符串或对象两种写法（与 router 侧 disabledList 同口径）。"""
    doc = json.loads(path.read_text(encoding="utf-8"))
    out: list[dict] = []
    for m in doc.get("models", []):
        if isinstance(m, str):
            out.append({"id": m, "reason": "", "reviewAt": None})
        elif isinstance(m, dict) and m.get("id"):
            out.append(m)
    return out


def parse_review_at(value: object) -> datetime | None:
    """解析 reviewAt；非法/缺失 ⇒ None（语义＝可随时复检）。"""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def due_state(entry: dict, now: datetime, force_all: bool) -> tuple[bool, str]:
    """返回 (是否该探测, 状态标签)。force_all 时忽略时点（--all）。"""
    if force_all:
        return True, "forced"
    ra = parse_review_at(entry.get("reviewAt"))
    if ra is None:
        return True, "due"          # 无声明恢复时刻 ⇒ 随时可复检
    if now >= ra:
        return True, "due"          # 已到点 ⇒ 具备判定价值
    return False, "not_due"          # 未到点 ⇒ 自动忽略（核心行为）


def _post(model: str, key: str, timeout: int) -> tuple[str, float, str]:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "Call the get_time tool."}],
        "max_tokens": 48,
        "tools": TOOLS,
        "tool_choice": "auto",
    }
    req = urllib.request.Request(
        f"{GATEWAY}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        msg = (resp.get("choices") or [{}])[0].get("message") or {}
        return ("200", (time.time() - t0) * 1000, json.dumps(msg, ensure_ascii=False)[:200])
    except urllib.error.HTTPError as e:
        return (
            str(e.code),
            (time.time() - t0) * 1000,
            e.read().decode("utf-8", "replace")[:200].replace("\n", " "),
        )
    except Exception as e:  # noqa: BLE001
        return (type(e).__name__, (time.time() - t0) * 1000, str(e)[:200])


def verdict_of(codes: list[str], body: str, ms: float) -> str:
    """成功率判定，只对确定性失败判死（与候选池健康巡检同语义）。"""
    fails = [c for c in codes if c != "200"]
    if "200" in codes:
        v = "flaky" if fails else "ok"
        if v == "ok" and '"tool_calls"' not in body:
            v = "tool_gap"
        if v == "ok" and ms > SLOW_MS:
            v = "slow"
        return v
    if fails and all(c == "429" for c in fails):
        return "suspended"
    if fails and all(c.isdigit() for c in fails) and "429" not in fails:
        return "unavailable"
    return "transient"


def probe(model: str, key: str, attempts: int, timeout: int) -> dict:
    """探测单个灰名单项；超时/网络错误早退（transient 与重试次数无关，重试无收益）。"""
    codes: list[str] = []
    last_code, last_ms, last_body = "", 0.0, ""
    for _ in range(max(1, attempts)):
        last_code, last_ms, last_body = _post(model, key, timeout)
        codes.append(last_code)
        if last_code == "200":
            break
        if not last_code.isdigit():  # 超时/网络 ⇒ transient 已定，重试无收益
            break
    return {
        "verdict": verdict_of(codes, last_body, last_ms),
        "codes": codes,
        "latency_ms": round(last_ms),
        "detail": last_body[:160],
    }


def expand(entries: list[dict], pool_file: Path | None) -> list[dict]:
    """把 `"<渠道>/*"` 通配展开为具体模型（否则无法逐个探测）。

    展开集来源：可选的候选池文件（每行一个 `<provider>/<model>`，`#` 开头为注释）。
    未提供或池内无该渠道成员 ⇒ 保留原样并标记 `unexpandable`，避免静默漏检。
    """
    pool: list[str] = []
    if pool_file and pool_file.exists():
        for line in pool_file.read_text(encoding="utf-8").splitlines():
            s = line.split("#", 1)[0].strip()
            if s:
                pool.append(s)
    out: list[dict] = []
    for e in entries:
        mid = e["id"]
        if mid.endswith("/*"):
            ch = mid[:-2]
            members = sorted({m for m in pool if m.split("/")[0] == ch})
            if not members:
                out.append({**e, "expandable": False})
                continue
            for m in members:
                out.append({**e, "id": m, "parentPattern": mid})
        else:
            out.append(e)
    return out


def self_test() -> int:
    """时点判定真值表自测（纯函数，零网络请求）。

    为何需要：本命令的**核心行为**就是「未到点自动忽略」——若这个判定退化
    （如把所有 reviewAt 都当成已到点），后果是每次巡检都发起全量探测，
    既浪费配额也与「没到点就自动忽略」的设计相违。必须有机器判据钉住。
    """
    # 参照时刻：2026-10-07T23:00Z。
    #   选此点可同时覆盖三种情形：
    #     · reviewAt 晚于该点 ⇒ 尚未到点（not_due）
    #     · reviewAt 早于或等于该点 ⇒ 到点（due）
    #     · 无/非法 reviewAt ⇒ 随时复检（due）
    now = datetime(2026, 10, 7, 23, 0, 0, tzinfo=timezone.utc)
    cases = [
        # (reviewAt, force_all, 期望应探, 期望标签)
        ("2026-10-07T00:00:00+08:00", False, True, "due"),           # 已到点（昨日）
        ("2026-10-08T09:00:00+08:00", False, False, "not_due"),      # 未到点
        ("2026-10-08T08:00:00+08:00", False, False, "not_due"),      # 未到点
        (None, False, True, "due"),                                   # 无时点 ⇒ 随时复检
        ("", False, True, "due"),                                     # 空串同无时点
        ("不是时间", False, True, "due"),                              # 非法值 ⇒ 不静默跳过
        ("2026-10-08T09:00:00+08:00", True, True, "forced"),          # --all 忽略时点
        ("2026-10-07T23:00:00+00:00", False, True, "due"),            # 恰好等于 now ⇒ 到点
        ("2026-10-07T23:00:01+00:00", False, False, "not_due"),       # 差 1 秒 ⇒ 未到点
    ]
    passed = failed = 0
    for ra, force, want_probe, want_state in cases:
        got_probe, got_state = due_state({"reviewAt": ra}, now, force)
        if got_probe == want_probe and got_state == want_state:
            passed += 1
        else:
            failed += 1
            print(f"  ✗ reviewAt={ra!r} force={force} ⇒ 期望 ({want_probe},{want_state}) 实得 ({got_probe},{got_state})")
    # 附加：确保 `--all` 不会把未到点当已到点以外的状态上报
    for ra, force, want_probe, want_state in cases[:3]:
        got_probe, got_state = due_state({"reviewAt": ra}, now, force)
        if got_probe != want_probe:
            failed += 1
            print(f"  ✗ 复验失败 reviewAt={ra!r}")
        else:
            passed += 1
    print(f"[scan-grey 自测] {passed} passed, {failed} failed")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="灰名单恢复巡检（只读，半人工）")
    ap.add_argument("--self-test", action="store_true", help="时点判定真值表自测（零网络，供 CI/门禁自检）")
    ap.add_argument("--file", type=Path, default=GREY_FILE, help=f"灰名单文件（默认 {GREY_FILE.name}）")
    ap.add_argument("--pool-file", type=Path, default=None,
                    help="候选池文件，每行一个 <provider>/<model>，用于展开 '渠道/*' 通配项")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--quiet", action="store_true", help="只输出结论行")
    ap.add_argument("--all", dest="force_all", action="store_true", help="忽略 reviewAt，强制全量探测")
    ap.add_argument("--list", action="store_true", help="只列时点状态，不探测（零请求）")
    ap.add_argument("--attempts", type=int, default=2, help="每模型探测次数（默认 2）")
    ap.add_argument("--timeout", type=int, default=30, help="单次请求超时秒数（默认 30）")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if not args.file.exists():
        return die(f"灰名单文件不存在：{args.file}")

    try:
        entries = load_grey(args.file)
    except Exception as e:  # noqa: BLE001
        return die(f"灰名单解析失败：{e}")

    now = datetime.now(timezone.utc)

    if args.list:
        for e in entries:
            _, state = due_state(e, now, args.force_all)
            ra = e.get("reviewAt") or "（无时点）"
            print(f"  [{state}] {e['id']}  reviewAt={ra}  {e.get('reason', '')}")
        print(f"[scan-grey] 灰名单 {len(entries)} 条（now={now.isoformat(timespec='seconds')}）")
        return 0

    if not entries:
        print("[scan-grey] 灰名单为空，无待巡检项")
        return 0

    expanded = expand(entries, args.pool_file)

    try:
        key, _ = load_secrets(DEFAULT_CONFIG)
    except Exception as e:  # noqa: BLE001
        return die(str(e))

    results: list[dict] = []
    for e in expanded:
        should, state = due_state(e, now, args.force_all)
        if not should:
            results.append({**e, "state": state, "probed": False})
            continue
        if e.get("expandable") is False:
            results.append({**e, "state": "unexpandable", "probed": False})
            continue
        r = probe(e["id"], key, args.attempts, args.timeout)
        results.append({**e, "state": state, "probed": True, **r})

    recovered = [r for r in results if r.get("probed") and r["verdict"] in
                 ("ok", "slow", "flaky", "tool_gap")]
    scanned = [r for r in results if r.get("probed")]
    skipped = [r for r in results if not r.get("probed")]

    if args.json:
        print(json.dumps({
            "grey": len(entries),
            "probed": len(scanned),
            "skipped": len(skipped),
            "recovered": [{"id": r["id"], "verdict": r["verdict"], "latency_ms": r["latency_ms"]} for r in recovered],
            "results": results,
            "now": now.isoformat(timespec="seconds"),
        }, ensure_ascii=False, indent=2))
        return 10 if recovered else 0

    if not args.quiet:
        for r in results:
            if not r.get("probed"):
                tag = {"not_due": "未到点", "unexpandable": "无法展开"}.get(r.get("state", ""), r.get("state", ""))
                print(f"  [{tag}] {r['id']}  reviewAt={r.get('reviewAt') or '（无时点）'}"
                      f"{'  ' + r['reason'] if r.get('reason') else ''}")
            else:
                mark = "✔" if r["verdict"] in ("ok", "slow", "flaky", "tool_gap") else "✗"
                print(f"  {mark} {r['id']}  {r['verdict']}  {r['latency_ms']}ms  {r.get('reason', '')}")

    print(f"[scan-grey] 灰名单 {len(entries)} 条 | 已探测 {len(scanned)} | 跳过（未到点）{len(skipped)}"
          f" | 已恢复 {len(recovered)}")
    if recovered:
        print("建议人工移除（本工具不自动改文件）：")
        for r in recovered:
            print(f"  · {r['id']}（{r['verdict']}）")
        return 10
    print("无需处置：无已恢复项。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
