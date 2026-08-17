# cc-status-line

Claude Code 状态栏与 CLIProxyAPI（CPA）多实例、多账户额度展示。

状态栏在一行内展示当前目录、Git 状态、模型、上下文窗口、Claude 官方订阅额度，以及当前 CPA 实例中对应 provider 的逐账户额度与重置倒计时。

## 功能

- Claude 官方订阅额度：`5h`、`7d`。
- Codex / GPT：读取上游真实额度窗口；上游缺少 `5h` 时只显示 `7d`。
- XAI / Grok：显示真实 weekly 额度（`wk`）。
- Antigravity / Gemini：同时显示 `5h` 与 `7d`。
- 多 CPA 实例：根据 `ANTHROPIC_BASE_URL` 自动选择 `pad` 或 `earnrmb`。
- 多账户：按邮箱 `@` 前缀平铺每个有效账户的额度与重置时间。
- 额度池约束：以已用比例最高、剩余最少的账户作为最紧约束，同时保留全部账户明细。
- 缓存超过 5 分钟时后台刷新，不阻塞状态栏；采集暂时失败时沿用旧数据并标记 `~`。
- 正常 CPA 额度使用 ANSI 256 色 `246` 弱显；剩余不超过 30% 时显示红色告警。

## 文件

- `statusline-command.sh`：读取 Claude Code status line JSON，渲染状态栏。
- `cliproxy-quota.py`：通过 CPA management API 代打上游额度接口，写入本地缓存。
- `install.sh`：将两个实现文件链接到 `~/.claude/`，保留现有 Claude Code 配置路径。

## 依赖

- POSIX `sh`
- Python 3
- `jq`
- `git`

## 安装

```sh
git clone git@github.com:kinka/cc-status-line.git ~/space/cc-status-line
cd ~/space/cc-status-line
./install.sh
```

安装脚本会创建：

```text
~/.claude/statusline-command.sh -> <仓库>/statusline-command.sh
~/.claude/cliproxy-quota.py    -> <仓库>/cliproxy-quota.py
```

如果目标位置存在内容不同的文件，安装脚本会先生成带时间戳的备份。

Claude Code 的 `~/.claude/settings.json` 需要包含：

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline-command.sh"
  }
}
```

## CPA 管理密钥

采集器从本机文件读取管理密钥，密钥不会写入源码：

```text
~/.claude/.cliproxy-mgmt-key   # pad
~/.claude/.earnrmb-mgmt-key    # earnrmb
```

建议将权限限制为仅当前用户可读：

```sh
chmod 600 ~/.claude/.cliproxy-mgmt-key \
  ~/.claude/.earnrmb-mgmt-key
```

不要将管理密钥、OAuth token 或生成的额度缓存提交到 Git。连续使用错误管理密钥请求 CPA management API 可能触发临时 IP 封禁。

## 实例与 provider 路由

实例优先根据当前 Claude Code 会话的 `ANTHROPIC_BASE_URL` 选择：

- 包含 `earnrmb`：使用 `earnrmb` 实例。
- 包含 `pad.gf.com.cn`：使用 `pad` 实例。
- 无法识别时：`grok-4.5` 回退到 `earnrmb`，其他模型回退到 `pad`。

provider 根据模型名或模型 ID 选择：

- `gpt` / `codex` → `codex`
- `grok` / `xai` → `xai`
- `gemini` / `antigravity` → `antigravity`

## 额度来源

采集器先调用 CPA 的 `/v0/management/auth-files` 获取账户，再通过 `/v0/management/api-call` 让 CPA 使用对应账户的 OAuth token 请求上游：

- Codex：`https://chatgpt.com/backend-api/wham/usage`
- XAI：`https://cli-chat-proxy.grok.com/v1/billing?format=credits`
- Antigravity：`https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`

XAI 响应中没有 `creditUsagePercent` 的账户不会计入额度池。Grok 当前上游只提供 weekly 订阅额度，因此状态栏不会推算或伪造 `5h`。

## 手动刷新与验证

刷新额度并打印结果：

```sh
python3 ~/.claude/cliproxy-quota.py --print
```

缓存写入：

```text
~/.claude/cliproxy-quota.json
```

只做语法检查：

```sh
sh -n statusline-command.sh
python3 -m py_compile cliproxy-quota.py
```

`--print` 输出包含账户邮箱和额度信息，仅应在可信的本地终端中使用。
