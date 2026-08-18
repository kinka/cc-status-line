# cc-status-line

Claude Code 状态栏与 CLIProxyAPI（CPA）多实例、多账户额度展示。

状态栏展示当前目录、Git 状态、模型、上下文窗口、Claude 官方订阅额度，以及当前 CPA 实例中对应 provider 的逐账户额度与重置倒计时；内容超出终端宽度时会在账户边界自动换行。

## 功能

- Claude 官方订阅额度：`5h`、`7d`。
- Codex / GPT：读取上游真实额度窗口；上游缺少 `5h` 时只显示 `7d`。
- XAI / Grok：显示真实 weekly 额度（`wk`）。
- Antigravity / Gemini：同时显示 `5h` 与 `7d`。
- 多 CPA 实例：以当前会话的 `ANTHROPIC_BASE_URL` 精确选择实例。
- 单一配置文件：在一个 JSON 中维护所有 CPA base URL、management key 和 provider allowlist。
- 多账户：按邮箱 `@` 前缀平铺有效账户；超宽时以账户为单位换行，不拆散同一账户的额度窗口。
- 缓存超过 5 分钟时由 Bun 后台刷新；采集暂时失败时沿用旧数据并标记 `~`。
- 正常 CPA 额度使用 ANSI 256 色 `246` 弱显；剩余不超过 30% 时显示红色告警。

## 文件

- `statusline-command.sh`：读取 Claude Code status line JSON，渲染状态栏。
- `cliproxy-quota.ts`：通过 CPA management API 代打上游额度接口，写入本地缓存。
- `cliproxy-config.example.json`：不含真实密钥的通用配置示例。
- `install.sh`：将运行文件链接到 `~/.claude/`。

## 依赖

- [Bun](https://bun.sh/)
- POSIX `sh`
- `jq`
- `git`

采集器是 Bun 直接执行的 TypeScript，运行时不需要 Python，也不需要安装 npm 依赖。

## 安装

```sh
git clone git@github.com:kinka/cc-status-line.git ~/space/cc-status-line
cd ~/space/cc-status-line
./install.sh
```

安装脚本会创建：

```text
~/.claude/statusline-command.sh -> <仓库>/statusline-command.sh
~/.claude/cliproxy-quota.ts     -> <仓库>/cliproxy-quota.ts
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

## 单一 CPA 配置

复制示例，并确保只有当前用户可读：

```sh
cp cliproxy-config.example.json ~/.claude/cliproxy-config.json
chmod 600 ~/.claude/cliproxy-config.json
```

配置格式：

```json
{
  "version": 1,
  "instances": {
    "http://cpa-a.example:8317": {
      "management_key": "replace-with-management-key",
      "providers": ["codex", "xai", "antigravity"]
    },
    "https://cpa-b.example": {
      "management_key": "replace-with-management-key",
      "providers": ["xai", "antigravity"],
      "management_url": "https://cpa-b.example/v0/management"
    }
  }
}
```

### 字段语义

- `instances` 的 key 是当前 Claude Code 会话使用的 `ANTHROPIC_BASE_URL`。
- statusline 去掉 URL 末尾 `/` 后精确匹配；未知 URL 不会回退到其他 CPA。
- `management_key` 是 CPA management API 的 bearer key，不是模型推理 API key。
- `management_url` 可选，默认是 `<base_url>/v0/management`。
- `providers` 可选，默认采集 `codex`、`xai`、`antigravity`；显式配置时只采集列出的 provider。
- 同一个 provider 可以存在于多个 base URL 中，每个实例使用自己的 management key 和账户池。

如果 management API 使用 HTTP，bearer key 会以明文在网络中传输；仅应在可信内网中使用。

## 从旧双 key 文件迁移

旧版本使用：

```text
~/.claude/.cliproxy-mgmt-key
~/.claude/.earnrmb-mgmt-key
```

可安全生成新的单一配置：

```sh
bun --no-env-file --use-system-ca \
  ~/.claude/cliproxy-quota.ts --migrate-config
```

迁移命令不会在输出中显示 key，也不会自动删除旧文件。验证新配置和真实采集成功后，再自行移除旧文件。

离线检查配置，不发起 management 请求：

```sh
bun --no-env-file --use-system-ca \
  ~/.claude/cliproxy-quota.ts --check-config
```

新配置存在但格式或权限错误时，采集器会直接失败，不会静默回退旧 key。

## 实例与 provider 路由

实例严格根据 `ANTHROPIC_BASE_URL` 选择。provider 根据模型名或模型 ID 选择：

- `gpt` / `codex` → `codex`
- `grok` / `xai` → `xai`
- `gemini` / `antigravity` → `antigravity`

无法识别实例或 provider 时只隐藏 CPA 额度，不影响官方额度、Git、上下文等状态栏内容。

## 额度来源

采集器先调用 CPA 的 `/v0/management/auth-files` 获取账户，再通过 `/v0/management/api-call` 让 CPA 使用对应账户的 OAuth token 请求上游：

- Codex：`https://chatgpt.com/backend-api/wham/usage`
- XAI：`https://cli-chat-proxy.grok.com/v1/billing?format=credits`
- Antigravity：`https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`

XAI 响应中没有 `creditUsagePercent` 的账户不会计入额度池。Grok 当前上游只提供 weekly 订阅额度，因此状态栏不会推算或伪造 `5h`。

采集器会清除 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY`，保持 CPA 直连；生产调用使用 Bun 的 `--no-env-file` 与 `--use-system-ca`。

## 手动刷新与验证

刷新额度但不打印账户信息：

```sh
bun --no-env-file --use-system-ca ~/.claude/cliproxy-quota.ts
```

刷新并打印结果：

```sh
bun --no-env-file --use-system-ca ~/.claude/cliproxy-quota.ts --print
```

`--print` 输出包含账户邮箱和额度信息，仅应在可信的本地终端中使用。

缓存写入：

```text
~/.claude/cliproxy-quota.json
```

配置和缓存均包含敏感或隐私信息，采集器会将它们限制为 `0600`。不要将 management key、OAuth token、真实配置或额度缓存提交到 Git。连续使用错误 management key 请求 CPA 可能触发临时 IP 封禁。

## 开发与测试

```sh
bun install
bun run typecheck
bun test
sh -n statusline-command.sh
sh -n install.sh
```

普通使用者不需要运行 `bun install`；它只用于类型检查和测试依赖。
