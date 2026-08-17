#!/usr/bin/env python3
"""CLIProxyAPI 额度采集器(多实例)。

从 CPA 管理 API 复现 Web UI「刷新额度」动作:
  POST /v0/management/api-call  用账户 auth_index + $TOKEN$ 占位符,
  让后端带账户 OAuth token 去打上游 usage 端点(能过 Cloudflare)。

- codex:       https://chatgpt.com/backend-api/wham/usage                -> plan + 5h/7d 窗口
- xai:         https://cli-chat-proxy.grok.com/v1/billing?format=credits -> 周限额已用%+分项+重置
- antigravity: https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
               (POST, body {"project": <project_id>},必须带 UA
               "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)" 否则 403)
               -> Gemini Models 分组的 weekly/5h remainingFraction,换算成 windows(与 codex 同构)

实例(每个都是一套 CPA,各自的 base + 管理密钥文件):
- pad:      内网 pad:8317      -> cx(gpt/codex) / cxx(grok/xai) / antigravity(gemini)
- earnrmb:  api.earnrmb.online -> cj(grok-4.5/xai) / antigravity(gemini)

结果写入 ~/.claude/cliproxy-quota.json,两级结构:
  {updated_at, pad:{codex,xai,antigravity}, earnrmb:{codex,xai,antigravity}}
statusline 按会话的 ANTHROPIC_BASE_URL 选实例、按 model 选 provider。
池化: 取「最紧」(used% 最高/剩余最少)的账户作为绑定约束(best,平铺在 provider 节点顶层,
向后兼容旧字段)。同时每个 provider 节点带 accounts:[...],按(排序用窗口的)used 降序
(最紧在前)列出全部有效账户明细,供 statusline 逐账户展示:
- codex/antigravity: accounts[i] = {email, windows:[{seconds,used,reset_at}, ...]},
  windows 是该账户的完整窗口集(5h+7d),不是只留排序用的那一个——否则 statusline 只能
  显示"最紧"的单个窗口,5h/7d 会随谁更紧而交替"消失"。
- xai: accounts[i] = {email, used, reset_at}(上游只有周额度,没有 5h 窗口)。
xai 仅计入「会员」账户(billing?format=credits 返回 creditUsagePercent 的);
返回 None 的为非会员,直接忽略,不计入池子数与 accounts 列表。
"""
import json
import os
import ssl
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

_CLAUDE = Path.home() / ".claude"
CACHE = _CLAUDE / "cliproxy-quota.json"
TIMEOUT = 25
CODEX_UA = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal"
ANTIGRAVITY_UA = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)"

# 多实例: name -> {base(管理API根), key_file(管理密钥)}
INSTANCES = {
    "pad": {
        "base": "http://pad.gf.com.cn:8317/v0/management",
        "key_file": _CLAUDE / ".cliproxy-mgmt-key",
    },
    "earnrmb": {
        "base": "https://api.earnrmb.online/v0/management",
        "key_file": _CLAUDE / ".earnrmb-mgmt-key",
    },
}

# 直连内网,绕过任何 http(s)_proxy 环境变量
_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=ssl.create_default_context()),
)


def _mgmt(inst, method, path, body=None):
    url = inst["base"] + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + inst["key_file"].read_text().strip())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with _OPENER.open(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _api_call(inst, auth_index, url, header, method="GET", data=None):
    """经管理 API 让后端用指定账户代打上游 url,返回 (status, parsed_body)。"""
    body = {"auth_index": auth_index, "method": method, "url": url, "header": header}
    if data is not None:
        body["data"] = data
    resp = _mgmt(inst, "POST", "/api-call", body)
    status = resp.get("status_code")
    body = resp.get("body", "")
    try:
        body = json.loads(body)
    except Exception:
        pass
    return status, body


def list_accounts(inst):
    """返回 [{provider, auth_index, email, disabled, failed}, ...]。"""
    d = _mgmt(inst, "GET", "/auth-files")
    out = []

    def walk(x):
        if isinstance(x, dict):
            if "provider" in x and "auth_index" in x:
                out.append(x)
            else:
                for v in x.values():
                    walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(d)
    return out


def codex_quota(inst, auth_index):
    """拉单个 codex 账户额度,返回 windows 列表 [{seconds, used, reset_at}] + plan。"""
    status, b = _api_call(
        inst, auth_index,
        "https://chatgpt.com/backend-api/wham/usage",
        {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json",
         "User-Agent": CODEX_UA},
    )
    if status != 200 or not isinstance(b, dict):
        return None
    rl = b.get("rate_limit") or {}
    windows = []
    for key in ("primary_window", "secondary_window"):
        w = rl.get(key)
        if isinstance(w, dict) and w.get("used_percent") is not None:
            windows.append({
                "seconds": w.get("limit_window_seconds"),
                "used": w.get("used_percent"),
                "reset_at": w.get("reset_at"),
            })
    return {"plan": b.get("plan_type"), "windows": windows}


def antigravity_quota(inst, auth_index, project_id):
    """拉单个 antigravity(Gemini)账户额度,返回 windows(与 codex_quota 同构)。

    上游按「组」返回配额,一个账户内 Gemini 系(Flash/Pro)与 Claude+GPT-OSS 系是分开
    结算的两组;这里只取 displayName 含 "Gemini" 的组。weekly/5h 两个 bucket 天然对应
    codex 的 604800s/18000s 窗口,故直接复用同一套 windows 结构与池化/渲染逻辑。"""
    if not project_id:
        return None
    status, b = _api_call(
        inst, auth_index,
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json",
         "User-Agent": ANTIGRAVITY_UA},
        method="POST", data=json.dumps({"project": project_id}),
    )
    if status != 200 or not isinstance(b, dict):
        return None
    gemini_group = next(
        (g for g in (b.get("groups") or []) if "gemini" in (g.get("displayName") or "").lower()),
        None,
    )
    if not gemini_group:
        return None
    windows = []
    for bucket_id, seconds in (("gemini-weekly", 604800), ("gemini-5h", 18000)):
        bk = next((x for x in gemini_group.get("buckets") or [] if x.get("bucketId") == bucket_id), None)
        if bk is None or bk.get("remainingFraction") is None:
            continue
        windows.append({
            "seconds": seconds,
            "used": round((1 - bk["remainingFraction"]) * 100, 2),
            "reset_at": _iso_epoch(bk.get("resetTime")),
        })
    return {"plan": None, "windows": windows}


def _iso_epoch(s):
    """ISO8601(含微秒/时区) -> epoch 秒;失败返回 None。"""
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def xai_quota(inst, auth_index):
    """拉单个 xai 账户「周限额」额度。

    须带 ?format=credits 才有 `creditUsagePercent`(周已用%)、`currentPeriod.end`(重置)
    与 `productUsage`(GrokBuild/GrokImagine/GrokChat 分项)。没有 creditUsagePercent 的
    账户按当前池规则视为非会员并忽略。而普通 /v1/billing 的 `used` 是全时段计数器,
    并非周额度,故弃用。"""
    status, b = _api_call(
        inst, auth_index,
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json"},
    )
    if status != 200 or not isinstance(b, dict):
        return None
    cfg = b.get("config") or {}
    cp = cfg.get("currentPeriod") or {}
    products = [
        {"name": p.get("product"), "used": p.get("usagePercent")}
        for p in (cfg.get("productUsage") or []) if p.get("usagePercent") is not None
    ]
    return {
        "used_pct": cfg.get("creditUsagePercent"),   # 周已用%;None=本周未消耗
        "reset_at": _iso_epoch(cp.get("end")) or _iso_epoch(cfg.get("billingPeriodEnd")),
        "products": products,
        "period_end": cfg.get("billingPeriodEnd"),
    }


def collect_codex(inst, accts):
    """池化: 取周窗口 used% 最高(剩余最少/最紧)的 codex 账户为 best,同时保留每个账户的
    明细(accounts,按 used 降序/最紧在前),供 statusline 需要时逐账户列出。"""
    codex_accts = [a for a in accts if a.get("provider") == "codex" and not a.get("disabled")]
    rows = []
    for a in codex_accts:
        try:
            q = codex_quota(inst, a["auth_index"])
        except Exception:
            q = None
        if not q or not q["windows"]:
            continue
        wk = max(q["windows"], key=lambda w: w.get("seconds") or 0)  # 最长窗口(通常7天)
        rows.append({"email": a.get("email"), "plan": q["plan"], "windows": q["windows"],
                     "used": wk["used"], "reset_at": wk["reset_at"]})
    if not rows:
        return None
    rows.sort(key=lambda r: r["used"], reverse=True)
    best = dict(rows[0])
    best.pop("used", None)
    best.pop("reset_at", None)
    best["accounts_total"] = len(codex_accts)
    best["accounts_usable"] = len(rows)
    # 每账户保留完整 windows(5h+7d),而不只是排序用的那一个窗口,
    # 避免 statusline 只显示"最紧"的单个窗口导致 5h/7d 交替"消失"。
    best["accounts"] = [{"email": r["email"], "windows": r["windows"]} for r in rows]
    return best


def collect_xai(inst, accts):
    """池化: 只认会员账户(有 creditUsagePercent),取已用% 最高(剩余最少/最紧)那个为
    best,同时保留每个会员账户的明细(accounts,按 used_pct 降序/最紧在前)。"""
    xai_accts = [a for a in accts if a.get("provider") == "xai" and not a.get("disabled")]
    rows = []
    for a in xai_accts:
        try:
            q = xai_quota(inst, a["auth_index"])
        except Exception:
            q = None
        if not q or q["used_pct"] is None:   # None = 非会员,忽略
            continue
        rows.append({"email": a.get("email"), "used_pct": q["used_pct"],
                     "reset_at": q["reset_at"], "products": q["products"],
                     "period_end": q.get("period_end")})
    out = {"accounts_total": len(rows), "accounts_usable": len(rows)}
    if rows:
        rows.sort(key=lambda r: r["used_pct"], reverse=True)
        out.update(rows[0])
        out["accounts"] = [{"email": r["email"], "used": r["used_pct"], "reset_at": r["reset_at"]} for r in rows]
    return out


def collect_antigravity(inst, accts):
    """池化: 取 Gemini 周窗口 used% 最高(剩余最少/最紧)的 antigravity 账户为 best,
    同时保留每个账户的明细(accounts,按 used 降序/最紧在前)。"""
    ag_accts = [a for a in accts if a.get("provider") == "antigravity" and not a.get("disabled")]
    rows = []
    for a in ag_accts:
        try:
            q = antigravity_quota(inst, a["auth_index"], a.get("project_id"))
        except Exception:
            q = None
        if not q or not q["windows"]:
            continue
        wk = max(q["windows"], key=lambda w: w.get("seconds") or 0)  # 周窗口(604800s)
        rows.append({"email": a.get("email"), "plan": q["plan"], "windows": q["windows"],
                     "used": wk["used"], "reset_at": wk["reset_at"]})
    if not rows:
        return None
    rows.sort(key=lambda r: r["used"], reverse=True)
    best = dict(rows[0])
    best.pop("used", None)
    best.pop("reset_at", None)
    best["accounts_total"] = len(ag_accts)
    best["accounts_usable"] = len(rows)
    best["accounts"] = [{"email": r["email"], "windows": r["windows"]} for r in rows]
    return best


def collect():
    """遍历所有实例,每个实例采集 codex + xai + antigravity 三类 provider。
    缓存两级: {updated_at, <实例名>: {codex:..., xai:..., antigravity:...}, ...}。
    statusline 按 ANTHROPIC_BASE_URL 选实例、按 model 选 provider。"""
    now = int(time.time())
    result = {"updated_at": now}
    for name, inst in INSTANCES.items():
        node = {"codex": None, "xai": None, "antigravity": None}
        try:
            accts = list_accounts(inst)
            node["codex"] = collect_codex(inst, accts)
            node["xai"] = collect_xai(inst, accts)
            node["antigravity"] = collect_antigravity(inst, accts)
        except Exception as e:
            sys.stderr.write(f"{name} collect failed: {type(e).__name__}: {e}\n")
        result[name] = node
    return result


def _has_quota(v):
    """provider 是否拿到了真实额度(而非仅账户计数)。"""
    if not isinstance(v, dict):
        return False
    # codex 有 windows;xai/cj 命中会员账户时会写入 reset_at
    return bool(v.get("windows")) or v.get("reset_at") is not None


def main():
    try:
        result = collect()
    except Exception as e:
        sys.stderr.write(f"cliproxy-quota collect failed: {type(e).__name__}: {e}\n")
        return 1
    # 兜底: 某实例某 provider 本次未拿到额度(间歇失败/被封)则沿用上次值,避免状态栏突然空掉
    if CACHE.exists():
        try:
            old = json.loads(CACHE.read_text())
            for inst in INSTANCES:
                for k in ("codex", "xai", "antigravity"):
                    cur = (result.get(inst) or {}).get(k)
                    prev = (old.get(inst) or {}).get(k)
                    if not _has_quota(cur) and _has_quota(prev):
                        stale = dict(prev)
                        stale["stale"] = True
                        result.setdefault(inst, {})[k] = stale
        except Exception:
            pass
    tmp = CACHE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False))
    os.replace(tmp, CACHE)
    if "--print" in sys.argv:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
