#!/bin/sh
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLAUDE_DIR="$HOME/.claude"

mkdir -p "$CLAUDE_DIR"

if ! command -v bun >/dev/null 2>&1; then
  printf '错误:未找到 Bun,请先安装 https://bun.sh\n' >&2
  exit 1
fi

install_link() {
  _name=$1
  _source="$REPO_DIR/$_name"
  _target="$CLAUDE_DIR/$_name"

  if [ -L "$_target" ] && [ "$(readlink "$_target")" = "$_source" ]; then
    printf '已安装: %s -> %s\n' "$_target" "$_source"
    return
  fi

  if [ -e "$_target" ] || [ -L "$_target" ]; then
    if [ -f "$_target" ] && cmp -s "$_source" "$_target"; then
      rm "$_target"
    else
      _backup="${_target}.bak.$(date +%Y%m%d%H%M%S)"
      mv "$_target" "$_backup"
      printf '已备份原文件: %s\n' "$_backup"
    fi
  fi

  ln -s "$_source" "$_target"
  printf '已安装: %s -> %s\n' "$_target" "$_source"
}

chmod 755 "$REPO_DIR/statusline-command.sh" "$REPO_DIR/cliproxy-quota.ts"
install_link statusline-command.sh
install_link cliproxy-quota.ts

# 仅清理本仓库旧版本创建的 Python 符号链接,不触碰用户自己的文件。
_legacy_link="$CLAUDE_DIR/cliproxy-quota.py"
if [ -L "$_legacy_link" ] && [ "$(readlink "$_legacy_link")" = "$REPO_DIR/cliproxy-quota.py" ]; then
  rm "$_legacy_link"
  printf '已移除旧链接: %s\n' "$_legacy_link"
fi

printf '\nCPA 配置检查/迁移:\n'
printf '  bun --no-env-file --use-system-ca %s --check-config\n' "$CLAUDE_DIR/cliproxy-quota.ts"
printf '  bun --no-env-file --use-system-ca %s --migrate-config\n' "$CLAUDE_DIR/cliproxy-quota.ts"

printf '\nClaude Code settings.json 应包含:\n'
printf '%s\n' '  "statusLine": {'
printf '%s\n' '    "type": "command",'
printf '%s\n' '    "command": "~/.claude/statusline-command.sh"'
printf '%s\n' '  }'
