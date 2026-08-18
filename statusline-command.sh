#!/bin/sh
# Claude Code statusLine command
# Based on the "kinka" oh-my-zsh theme (bureau-style)

input=$(cat)

# Extract values from JSON input (single jq pass)
# fields: cwd, model, ctx remaining, 5h/7d used%, 5h/7d reset epoch
_fields=$(echo "$input" | jq -r '
  [ (.cwd // .workspace.current_dir // "."),
    (.model.display_name // "Claude"),
    (.context_window.remaining_percentage // ""),
    (.rate_limits.five_hour.used_percentage // ""),
    (.rate_limits.five_hour.resets_at // ""),
    (.rate_limits.seven_day.used_percentage // ""),
    (.rate_limits.seven_day.resets_at // ""),
    (.model.id // "")
  ] | @tsv')

cwd=$(echo "$_fields" | cut -f1)
model=$(echo "$_fields" | cut -f2)
remaining=$(echo "$_fields" | cut -f3)
h5_used=$(echo "$_fields" | cut -f4)
h5_reset=$(echo "$_fields" | cut -f5)
d7_used=$(echo "$_fields" | cut -f6)
d7_reset=$(echo "$_fields" | cut -f7)
model_id=$(echo "$_fields" | cut -f8)

# User and path
user=$(whoami)
# Show ~ for home directory prefix
home="$HOME"
display_path="${cwd#$home}"
if [ "$display_path" != "$cwd" ]; then
  display_path="~$display_path"
fi

# Git branch and status (skip optional locks)
git_branch=""
git_status_str=""
if git -C "$cwd" rev-parse --git-dir > /dev/null 2>&1; then
  git_branch=$(git -C "$cwd" symbolic-ref HEAD 2>/dev/null | sed 's|refs/heads/||') \
    || git_branch=$(git -C "$cwd" rev-parse --short HEAD 2>/dev/null)

  if [ -n "$git_branch" ]; then
    _index=$(git -C "$cwd" status --porcelain 2>/dev/null)
    _index_b=$(git -C "$cwd" status --porcelain -b 2>/dev/null)
    _st=""
    if echo "$_index" | grep -q '^[AMRD]. '; then
      _st="${_st}●"  # staged
    fi
    if echo "$_index" | grep -q '^.[MTD] '; then
      _st="${_st}●"  # unstaged
    fi
    if echo "$_index" | grep -q -E '^\?\? '; then
      _st="${_st}●"  # untracked
    fi
    if [ -z "$_index" ]; then
      _st="✓"
    fi
    if echo "$_index_b" | grep -q '^## .*ahead'; then
      _st="${_st}▴"
    fi
    if echo "$_index_b" | grep -q '^## .*behind'; then
      _st="${_st}▾"
    fi
    if [ -n "$_st" ]; then
      git_status_str=" [±${git_branch} ${_st}]"
    else
      git_status_str=" [±${git_branch}]"
    fi
  fi
fi

# Time
time_str=$(date +%H:%M:%S)

# ANSI colors — real ESC bytes so they survive being passed through printf's %s
ESC=$(printf '\033')
BOLD="${ESC}[1m"
GREEN="${ESC}[32m"
YELLOW="${ESC}[33m"
RED="${ESC}[31m"
CYAN="${ESC}[36m"
WHITE="${ESC}[37m"
MUTED="${ESC}[38;5;246m"  # 显式浅灰(#949494),比终端 DIM 更不显眼且不受主题 DIM 映射影响
DIM="${ESC}[2m"
RESET="${ESC}[0m"

# Context window info
ctx_str=""
if [ -n "$remaining" ]; then
  ctx_str=" ${DIM}ctx:${remaining}%${RESET}"
fi

# Subscription quota (rate_limits): show REMAINING share + reset countdown.
# Only present for Claude.ai subscribers, after the first API response.
now=$(date +%s)

# usage_seg <label> <used_percentage> <resets_at_epoch>
usage_seg() {
  _label="$1"; _used="$2"; _reset="$3"
  [ -z "$_used" ] && return 0

  # remaining = 100 - used, rounded to integer
  _left=$(awk -v u="$_used" 'BEGIN{ l=100-u; if (l<0) l=0; printf "%d", (l+0.5) }')

  if [ "$_left" -le 10 ]; then
    _color="$RED"
  elif [ "$_left" -le 30 ]; then
    _color="$YELLOW"
  else
    _color="$GREEN"
  fi

  # countdown to window reset
  _eta=""
  if [ -n "$_reset" ]; then
    _secs=$(awk -v r="$_reset" -v n="$now" 'BEGIN{ printf "%d", r-n }')
    if [ "$_secs" -gt 0 ]; then
      _d=$((_secs / 86400))
      _h=$(((_secs % 86400) / 3600))
      _m=$(((_secs % 3600) / 60))
      if [ "$_d" -gt 0 ]; then
        _eta="${_d}d${_h}h"
      elif [ "$_h" -gt 0 ]; then
        _eta="${_h}h${_m}m"
      else
        _eta="${_m}m"
      fi
      _eta="${DIM}↻${_eta}${RESET}"
    fi
  fi

  printf " ${DIM}%s${RESET}${_color}%s%%${RESET}%s" "$_label" "$_left" "$_eta"
}

# CPA 逐账户额度:正常信息使用显式 256 色浅灰,仅剩余≤30%时使用亮红告警。
usage_seg_weak() {
  _label="$1"; _used="$2"; _reset="$3"
  [ -z "$_used" ] && return 0

  _left=$(awk -v u="$_used" 'BEGIN{ l=100-u; if (l<0) l=0; printf "%d", (l+0.5) }')
  if [ "$_left" -le 30 ]; then
    _style="$RED"
  else
    _style="$MUTED"
  fi

  _eta=""
  if [ -n "$_reset" ]; then
    _secs=$(awk -v r="$_reset" -v n="$now" 'BEGIN{ printf "%d", r-n }')
    if [ "$_secs" -gt 0 ]; then
      _d=$((_secs / 86400)); _h=$(((_secs % 86400) / 3600)); _m=$(((_secs % 3600) / 60))
      if [ "$_d" -gt 0 ]; then _eta="${_d}d${_h}h"; elif [ "$_h" -gt 0 ]; then _eta="${_h}h${_m}m"; else _eta="${_m}m"; fi
      _eta="↻${_eta}"
    fi
  fi

  printf " ${MUTED}%s${RESET}${_style}%s%%${RESET}" "$_label" "$_left"
  [ -n "$_eta" ] && printf "${MUTED}%s${RESET}" "$_eta"
}

quota_str="$(usage_seg '5h:' "$h5_used" "$h5_reset")$(usage_seg '7d:' "$d7_used" "$d7_reset")"
if [ -n "$quota_str" ]; then
  quota_str=" ${DIM}|${RESET}${quota_str}"
fi

# --- CLIProxyAPI 额度 (cx/cxx/cj 走自建 CPA 代理时) ---
# 实例(哪套 CPA)由会话的 ANTHROPIC_BASE_URL 决定,provider 由 model 决定。
# v2 缓存按规范化 base_url 分实例: {instances:{<base_url>:{provider:...}}}。
CPQ_CACHE="$HOME/.claude/cliproxy-quota.json"
CPQ_COLLECT="$HOME/.claude/cliproxy-quota.ts"
CPQ_TTL=300          # 缓存超过 5 分钟即后台刷新
cliproxy_str=""
_m=$(printf '%s%s' "$model_id" "$model" | tr 'A-Z' 'a-z')
# provider: gpt/codex -> codex; grok/xai -> xai; gemini/antigravity -> antigravity(windows结构与codex同构)
case "$_m" in
  *gpt*|*codex*)          _PROV="codex"; _PLABEL="gpt" ;;
  *grok*|*xai*)           _PROV="xai" ;;
  *gemini*|*antigravity*) _PROV="antigravity"; _PLABEL="gem" ;;
  *)                      _PROV="" ;;
esac
if [ -n "$_PROV" ] && [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  # 实例严格按当前会话 base URL 选择。仅去掉末尾斜杠,未知 URL 不回退到其他 CPA。
  _INST=$(printf '%s' "$ANTHROPIC_BASE_URL" | sed 's:/*$::')
  # 一个兼容版本内允许两条历史 URL 读取旧 pad/earnrmb 顶层缓存键。
  case "$_INST" in
    http://pad.gf.com.cn:8317)    _LEGACY_INST="pad" ;;
    https://api.earnrmb.online)  _LEGACY_INST="earnrmb" ;;
    *)                            _LEGACY_INST="" ;;
  esac
  # 缓存过期或仍是旧 schema 时后台异步刷新,本次继续显示可用旧值。
  if [ -f "$CPQ_COLLECT" ] && command -v bun >/dev/null 2>&1; then
    _age=999999
    if [ -f "$CPQ_CACHE" ]; then
      _upd=$(jq -r '.updated_at // 0' "$CPQ_CACHE" 2>/dev/null)
      _schema=$(jq -r '.schema_version // 1' "$CPQ_CACHE" 2>/dev/null)
      [ -n "$_upd" ] && _age=$(( now - _upd ))
      [ "$_schema" != "2" ] && _age=999999
    fi
    if [ "$_age" -ge "$CPQ_TTL" ]; then
      (
        unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
        bun --no-env-file --use-system-ca "$CPQ_COLLECT" >/dev/null 2>&1 &
      ) 2>/dev/null
    fi
  fi
  cliproxy_detail=""
  if [ -f "$CPQ_CACHE" ]; then
    if [ "$_PROV" = "xai" ]; then
      # xai 上游只有周额度,没有 5h 窗口。去掉池总览,只平铺各账户真实额度。
      # 逐账户明细: 追加在同一行末尾,账户用邮箱前缀(@ 前最多 8 字符)+ 周剩余% + 重置倒计时
      # 字段分隔符用 \x1f(非空白)而不是 \t: read 在 IFS 为空白字符(含 tab)时会
      # 把连续分隔符合并,导致中间的空字段被吃掉、后续字段全部错位。
      _acc_tsv=$(jq -r --arg i "$_INST" --arg legacy "$_LEGACY_INST" '
        (if .schema_version == 2 then .instances[$i].xai
         elif $legacy != "" then .[$legacy].xai else null end) as $quota
        | ($quota.accounts // [])
        | if length==0 then empty else
            .[] | "\(.email // "?")\(.used)\(.reset_at // "")"
          end' "$CPQ_CACHE" 2>/dev/null)
      if [ -n "$_acc_tsv" ]; then
        while IFS="$(printf '\037')" read -r _ae _au _ar; do
          [ -z "$_ae" ] && continue
          _al=$(printf '%s' "$_ae" | cut -d'@' -f1 | cut -c1-8)
          _account_seg="${MUTED}${_al}${RESET}$(usage_seg_weak 'wk:' "$_au" "$_ar")"
          if [ -n "$cliproxy_detail" ]; then
            cliproxy_detail="${cliproxy_detail}
${_account_seg}"
          else
            cliproxy_detail="$_account_seg"
          fi
        done <<EOF
$_acc_tsv
EOF
      fi
      if [ -n "$cliproxy_detail" ]; then
        _stale=$(jq -r --arg i "$_INST" --arg legacy "$_LEGACY_INST" '
          (if .schema_version == 2 then .instances[$i].xai
           elif $legacy != "" then .[$legacy].xai else null end).stale // false
        ' "$CPQ_CACHE" 2>/dev/null)
        _st=""; [ "$_stale" = "true" ] && _st="~"
        cliproxy_str=" ${MUTED}| grok${_st}${RESET}"
      fi
    else
      # codex/antigravity: 去掉池总览,只平铺每个账户自己的 5h + 7d。
      # 逐账户明细: 追加在同一行末尾,账户用邮箱前缀(@ 前最多 8 字符)+ 自己的 5h + 7d
      _acc_tsv=$(jq -r --arg i "$_INST" --arg legacy "$_LEGACY_INST" --arg p "$_PROV" '
        (if .schema_version == 2 then .instances[$i][$p]
         elif $legacy != "" then .[$legacy][$p] else null end) as $quota
        | ($quota.accounts // [])
        | if length==0 then empty else
            .[] | . as $a
            | ($a.windows // []) as $ws
            | ($ws | map(select(.seconds==18000 and .used!=null)) | (.[0] // {})) as $w5
            | ($ws | map(select(.seconds==604800 and .used!=null)) | (.[0] // {})) as $w7
            | "\($a.email // "?")\($w5.used // "")\($w5.reset_at // "")\($w7.used // "")\($w7.reset_at // "")"
          end' "$CPQ_CACHE" 2>/dev/null)
      if [ -n "$_acc_tsv" ]; then
        while IFS="$(printf '\037')" read -r _ae _aw5u _aw5r _aw7u _aw7r; do
          [ -z "$_ae" ] && continue
          _al=$(printf '%s' "$_ae" | cut -d'@' -f1 | cut -c1-8)
          _account_seg="${MUTED}${_al}${RESET}$(usage_seg_weak '5h:' "$_aw5u" "$_aw5r")$(usage_seg_weak '7d:' "$_aw7u" "$_aw7r")"
          if [ -n "$cliproxy_detail" ]; then
            cliproxy_detail="${cliproxy_detail}
${_account_seg}"
          else
            cliproxy_detail="$_account_seg"
          fi
        done <<EOF
$_acc_tsv
EOF
      fi
      if [ -n "$cliproxy_detail" ]; then
        _stale=$(jq -r --arg i "$_INST" --arg legacy "$_LEGACY_INST" --arg p "$_PROV" '
          (if .schema_version == 2 then .instances[$i][$p]
           elif $legacy != "" then .[$legacy][$p] else null end).stale // false
        ' "$CPQ_CACHE" 2>/dev/null)
        _st=""; [ "$_stale" = "true" ] && _st="~"
        cliproxy_str=" ${MUTED}| ${_PLABEL}${_st}${RESET}"
      fi
    fi
  fi
fi

# Compose output: user  path  [git]  model  [time]  ctx | 官方额度 | CLIProxyAPI逐账户额度
# 账户在终端宽度内保持同一行;超宽时只在账户边界换行,不拆散单个账户的额度窗口。
_base_line=$(printf "${BOLD}${WHITE}%s${RESET} ${BOLD}${WHITE}%s${RESET}${GREEN}%s${RESET}  ${CYAN}%s${RESET}  [%s]%s%s%s" \
  "$user" "$display_path" "$git_status_str" "$model" "$time_str" "$ctx_str" "$quota_str" "$cliproxy_str")

# 优先使用继承的 COLUMNS,否则从控制终端读取;非交互环境回退到 120 列。
terminal_cols=${COLUMNS:-}
case "$terminal_cols" in ''|*[!0-9]*) terminal_cols="" ;; esac
if [ -z "$terminal_cols" ]; then
  _terminal_size=$(stty size </dev/tty 2>/dev/null || true)
  terminal_cols=${_terminal_size##* }
fi
case "$terminal_cols" in ''|*[!0-9]*) terminal_cols=120 ;; esac
[ "$terminal_cols" -lt 40 ] && terminal_cols=40

visible_length() {
  _plain=$(printf '%s' "$1" | sed "s/${ESC}\\[[0-9;]*m//g")
  printf '%s' "$_plain" | wc -m | tr -d ' '
}

if [ -z "$cliproxy_detail" ]; then
  printf '%s\n' "$_base_line"
else
  _line="$_base_line"
  while IFS= read -r _account_seg; do
    [ -z "$_account_seg" ] && continue
    _candidate="${_line}  ${_account_seg}"
    _candidate_len=$(visible_length "$_candidate")
    if [ "$_candidate_len" -gt "$terminal_cols" ]; then
      printf '%s\n' "$_line"
      _line="  ${_account_seg}"
    else
      _line="$_candidate"
    fi
  done <<EOF
$cliproxy_detail
EOF
  printf '%s\n' "$_line"
fi
