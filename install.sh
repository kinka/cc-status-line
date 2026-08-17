#!/bin/sh
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLAUDE_DIR="$HOME/.claude"

mkdir -p "$CLAUDE_DIR"

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

chmod 755 "$REPO_DIR/statusline-command.sh" "$REPO_DIR/cliproxy-quota.py"
install_link statusline-command.sh
install_link cliproxy-quota.py

printf '\nClaude Code settings.json 应包含:\n'
printf '%s\n' '  "statusLine": {'
printf '%s\n' '    "type": "command",'
printf '%s\n' '    "command": "~/.claude/statusline-command.sh"'
printf '%s\n' '  }'
