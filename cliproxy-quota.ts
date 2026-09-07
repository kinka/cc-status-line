#!/usr/bin/env bun
/**
 * CLIProxyAPI 多实例额度采集器。
 *
 * 实例与 management key 由 ~/.claude/cliproxy-config.json 配置，
 * 采集结果写入 ~/.claude/cliproxy-quota.json。
 */
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

for (const name of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]) {
  delete process.env[name];
}

export const SUPPORTED_PROVIDERS = [
  "codex",
  "xai",
  "antigravity",
  "claude",
] as const;
export type Provider = (typeof SUPPORTED_PROVIDERS)[number];

const SUPPORTED_PROVIDER_SET = new Set<string>(SUPPORTED_PROVIDERS);
const TIMEOUT_MS = 25_000;
const CODEX_UA =
  "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";
const ANTIGRAVITY_UA =
  "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)";

const LEGACY_SPECS = [
  {
    baseUrl: "http://pad.gf.com.cn:8317",
    keyFile: ".cliproxy-mgmt-key",
    cacheKey: "pad",
  },
  {
    baseUrl: "https://api.earnrmb.online",
    keyFile: ".earnrmb-mgmt-key",
    cacheKey: "earnrmb",
  },
] as const;

export interface RuntimePaths {
  claudeDir: string;
  config: string;
  cache: string;
}

export interface InstanceConfig {
  baseUrl: string;
  managementUrl: string;
  managementKey: string;
  providers: Provider[];
}

export interface EffectiveConfig {
  version: 1;
  source: "config" | "legacy";
  instances: Map<string, InstanceConfig>;
}

export interface QuotaWindow {
  seconds: number | null;
  used: number;
  reset_at: number | null;
}

interface AccountRecord {
  provider?: unknown;
  auth_index?: unknown;
  email?: unknown;
  disabled?: unknown;
  project_id?: unknown;
  [key: string]: unknown;
}

interface CodexQuota {
  plan: string | null;
  windows: QuotaWindow[];
}

interface XaiQuota {
  used_pct: number | null;
  reset_at: number | null;
  products: Array<{ name: string | null; used: number }>;
  period_end: string | null;
}

export type ProviderQuota = Record<string, unknown> | null;
export type InstanceQuota = Partial<Record<Provider, ProviderQuota>>;

export interface CacheV2 {
  schema_version: 2;
  updated_at: number;
  instances: Record<string, InstanceQuota>;
}

export function runtimePaths(): RuntimePaths {
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return {
    claudeDir,
    config: join(claudeDir, "cliproxy-config.json"),
    cache: join(claudeDir, "cliproxy-quota.json"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${path}.${key}: unknown field`);
    }
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeBaseUrl(value: unknown, path = "base_url"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path}: must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${path}: must not contain surrounding whitespace`);
  }
  const normalized = trimTrailingSlashes(value);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${path}: must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${path}: only http and https are supported`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${path}: credentials, query and fragment are not allowed`);
  }
  return normalized;
}

function parseProviders(value: unknown, path: string): Provider[] {
  if (value === undefined) {
    return [...SUPPORTED_PROVIDERS];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path}: must be a non-empty array`);
  }
  const providers: Provider[] = [];
  const seen = new Set<string>();
  for (const provider of value) {
    if (typeof provider !== "string" || !SUPPORTED_PROVIDER_SET.has(provider)) {
      throw new Error(
        `${path}: supported values are ${SUPPORTED_PROVIDERS.join(", ")}`,
      );
    }
    if (seen.has(provider)) {
      throw new Error(`${path}: duplicate provider ${provider}`);
    }
    seen.add(provider);
    providers.push(provider as Provider);
  }
  return providers;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertSecureRegularFile(
  path: string,
  label: string,
  fixPermissions = false,
): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label}: must be a regular file, not a symlink`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label}: must be owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    if (!fixPermissions) {
      throw new Error(`${label}: permissions must not allow group/other access`);
    }
    await chmod(path, 0o600);
  }
}

function parseConfigObject(value: unknown, source: EffectiveConfig["source"]): EffectiveConfig {
  if (!isRecord(value)) throw new Error("config: root must be an object");
  assertKnownFields(value, ["version", "instances"], "config");
  if (value.version !== 1) throw new Error("config.version: must be 1");
  if (!isRecord(value.instances) || Object.keys(value.instances).length === 0) {
    throw new Error("config.instances: must be a non-empty object");
  }

  const instances = new Map<string, InstanceConfig>();
  for (const [rawBaseUrl, rawInstance] of Object.entries(value.instances)) {
    const path = `config.instances[${JSON.stringify(rawBaseUrl)}]`;
    const baseUrl = normalizeBaseUrl(rawBaseUrl, `${path} key`);
    if (instances.has(baseUrl)) {
      throw new Error(`${path}: duplicate normalized base URL`);
    }
    if (!isRecord(rawInstance)) throw new Error(`${path}: must be an object`);
    assertKnownFields(
      rawInstance,
      ["management_key", "management_url", "providers"],
      path,
    );
    if (
      typeof rawInstance.management_key !== "string" ||
      rawInstance.management_key.trim() === ""
    ) {
      throw new Error(`${path}.management_key: must be a non-empty string`);
    }
    const managementUrl = normalizeBaseUrl(
      rawInstance.management_url ?? `${baseUrl}/v0/management`,
      `${path}.management_url`,
    );
    const providers = parseProviders(rawInstance.providers, `${path}.providers`);
    instances.set(baseUrl, {
      baseUrl,
      managementUrl,
      managementKey: rawInstance.management_key.trim(),
      providers,
    });
  }
  return { version: 1, source, instances };
}

export async function loadLegacyConfig(
  paths = runtimePaths(),
): Promise<EffectiveConfig> {
  const instances = new Map<string, InstanceConfig>();
  for (const spec of LEGACY_SPECS) {
    const keyPath = join(paths.claudeDir, spec.keyFile);
    if (!(await pathExists(keyPath))) continue;
    await assertSecureRegularFile(keyPath, keyPath);
    const managementKey = (await readFile(keyPath, "utf8")).trim();
    if (!managementKey) throw new Error(`${keyPath}: key must not be empty`);
    instances.set(spec.baseUrl, {
      baseUrl: spec.baseUrl,
      managementUrl: `${spec.baseUrl}/v0/management`,
      managementKey,
      providers: [...SUPPORTED_PROVIDERS],
    });
  }
  if (instances.size === 0) {
    throw new Error(`config not found: ${paths.config}`);
  }
  return { version: 1, source: "legacy", instances };
}

export async function loadConfig(
  paths = runtimePaths(),
  allowLegacy = true,
): Promise<EffectiveConfig> {
  if (!(await pathExists(paths.config))) {
    if (!allowLegacy) throw new Error(`config not found: ${paths.config}`);
    return loadLegacyConfig(paths);
  }
  await assertSecureRegularFile(paths.config, paths.config);
  const text = await readFile(paths.config, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${paths.config}: invalid JSON: ${errorMessage(error)}`);
  }
  return parseConfigObject(parsed, "config");
}

async function managementRequest(
  instance: InstanceConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${instance.managementUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${instance.managementKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
    tls: { rejectUnauthorized: true },
  });
  if (!response.ok) {
    throw new Error(`management HTTP ${response.status}`);
  }
  const text = await response.text();
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error("management response must be an object");
  return parsed;
}

async function apiCall(
  instance: InstanceConfig,
  authIndex: string | number,
  url: string,
  header: Record<string, string>,
  method = "GET",
  data?: string,
): Promise<{ status: number | null; body: unknown }> {
  const requestBody: Record<string, unknown> = {
    auth_index: authIndex,
    method,
    url,
    header,
  };
  if (data !== undefined) requestBody.data = data;
  const response = await managementRequest(instance, "POST", "/api-call", requestBody);
  const status =
    typeof response.status_code === "number" ? response.status_code : null;
  let body: unknown = response.body ?? "";
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // 上游也可能返回普通字符串，保持原值。
    }
  }
  return { status, body };
}

export async function listAccounts(
  instance: InstanceConfig,
): Promise<AccountRecord[]> {
  const data = await managementRequest(instance, "GET", "/auth-files");
  const accounts: AccountRecord[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    if ("provider" in value && "auth_index" in value) {
      accounts.push(value as AccountRecord);
      return;
    }
    for (const item of Object.values(value)) walk(item);
  };
  walk(data);
  return accounts;
}

function authIndex(account: AccountRecord): string | number | null {
  return typeof account.auth_index === "string" ||
    typeof account.auth_index === "number"
    ? account.auth_index
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// 限流响应头的值是字符串形式的数字("0.45"/"1788762000")。
function numericString(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function codexQuota(
  instance: InstanceConfig,
  index: string | number,
): Promise<CodexQuota | null> {
  const { status, body } = await apiCall(
    instance,
    index,
    "https://chatgpt.com/backend-api/wham/usage",
    {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": CODEX_UA,
    },
  );
  if (status !== 200 || !isRecord(body)) return null;
  const rateLimit = isRecord(body.rate_limit) ? body.rate_limit : {};
  const windows: QuotaWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = rateLimit[key];
    if (!isRecord(window)) continue;
    const used = nullableNumber(window.used_percent);
    if (used === null) continue;
    windows.push({
      seconds: nullableNumber(window.limit_window_seconds),
      used,
      reset_at: nullableNumber(window.reset_at),
    });
  }
  return { plan: nullableString(body.plan_type), windows };
}

export function isoEpoch(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.trunc(milliseconds / 1000) : null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function antigravityQuota(
  instance: InstanceConfig,
  index: string | number,
  projectId: string | null,
): Promise<CodexQuota | null> {
  if (!projectId) return null;
  const { status, body } = await apiCall(
    instance,
    index,
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": ANTIGRAVITY_UA,
    },
    "POST",
    JSON.stringify({ project: projectId }),
  );
  if (status !== 200 || !isRecord(body) || !Array.isArray(body.groups)) {
    return null;
  }
  const group = body.groups.find(
    (item) =>
      isRecord(item) &&
      typeof item.displayName === "string" &&
      item.displayName.toLowerCase().includes("gemini"),
  );
  if (!isRecord(group) || !Array.isArray(group.buckets)) return null;
  const windows: QuotaWindow[] = [];
  for (const [bucketId, seconds] of [
    ["gemini-weekly", 604800],
    ["gemini-5h", 18000],
  ] as const) {
    const bucket = group.buckets.find(
      (item) => isRecord(item) && item.bucketId === bucketId,
    );
    if (!isRecord(bucket)) continue;
    const remaining = nullableNumber(bucket.remainingFraction);
    if (remaining === null) continue;
    windows.push({
      seconds,
      used: round2((1 - remaining) * 100),
      reset_at: isoEpoch(bucket.resetTime),
    });
  }
  return { plan: null, windows };
}

export async function xaiQuota(
  instance: InstanceConfig,
  index: string | number,
): Promise<XaiQuota | null> {
  const { status, body } = await apiCall(
    instance,
    index,
    "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json" },
  );
  if (status !== 200 || !isRecord(body)) return null;
  const config = isRecord(body.config) ? body.config : {};
  const currentPeriod = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const products = Array.isArray(config.productUsage)
    ? config.productUsage.flatMap((product) => {
        if (!isRecord(product)) return [];
        const used = nullableNumber(product.usagePercent);
        if (used === null) return [];
        return [{ name: nullableString(product.product), used }];
      })
    : [];
  return {
    used_pct: nullableNumber(config.creditUsagePercent),
    reset_at:
      isoEpoch(currentPeriod.end) ?? isoEpoch(config.billingPeriodEnd),
    products,
    period_end: nullableString(config.billingPeriodEnd),
  };
}

const CLAUDE_WINDOWS = [
  ["5h", 18000],
  ["7d", 604800],
] as const;

/**
 * claude 账户不需要回源:CPA 已把上游 Anthropic 的 unified 限流响应头
 * 缓存在 /auth-files 的 quota.signals 里(utilization 是 0~1 的比例)。
 */
export function claudeQuota(account: AccountRecord): CodexQuota | null {
  const quota = isRecord(account.quota) ? account.quota : null;
  if (!quota || !isRecord(quota.signals)) return null;
  const signals = new Map<string, unknown>();
  for (const [key, value] of Object.entries(quota.signals)) {
    signals.set(key.toLowerCase(), value);
  }
  const windows: QuotaWindow[] = [];
  for (const [label, seconds] of CLAUDE_WINDOWS) {
    const utilization = numericString(
      signals.get(`anthropic-ratelimit-unified-${label}-utilization`),
    );
    if (utilization === null) continue;
    windows.push({
      seconds,
      used: round2(utilization * 100),
      reset_at: numericString(
        signals.get(`anthropic-ratelimit-unified-${label}-reset`),
      ),
    });
  }
  if (windows.length === 0) return null;
  return { plan: nullableString(account.account_type), windows };
}

function accountEmail(account: AccountRecord): string | null {
  return nullableString(account.email);
}

function enabledAccounts(
  accounts: AccountRecord[],
  provider: Provider,
): AccountRecord[] {
  return accounts.filter(
    (account) => account.provider === provider && account.disabled !== true,
  );
}

export async function collectCodex(
  instance: InstanceConfig,
  accounts: AccountRecord[],
): Promise<ProviderQuota> {
  const candidates = enabledAccounts(accounts, "codex");
  const rows: Array<{
    email: string | null;
    plan: string | null;
    windows: QuotaWindow[];
    used: number;
  }> = [];
  for (const account of candidates) {
    const index = authIndex(account);
    if (index === null) continue;
    let quota: CodexQuota | null = null;
    try {
      quota = await codexQuota(instance, index);
    } catch {
      // 单账户失败不影响同池其他账户。
    }
    if (!quota || quota.windows.length === 0) continue;
    const weekly = quota.windows.reduce((best, window) =>
      (window.seconds ?? 0) > (best.seconds ?? 0) ? window : best,
    );
    rows.push({
      email: accountEmail(account),
      plan: quota.plan,
      windows: quota.windows,
      used: weekly.used,
    });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.used - a.used);
  const best = rows[0];
  return {
    email: best.email,
    plan: best.plan,
    windows: best.windows,
    accounts_total: candidates.length,
    accounts_usable: rows.length,
    accounts: rows.map((row) => ({
      email: row.email,
      windows: row.windows,
    })),
  };
}

export async function collectXai(
  instance: InstanceConfig,
  accounts: AccountRecord[],
): Promise<ProviderQuota> {
  const candidates = enabledAccounts(accounts, "xai");
  const rows: Array<{
    email: string | null;
    used_pct: number;
    reset_at: number | null;
    products: Array<{ name: string | null; used: number }>;
    period_end: string | null;
  }> = [];
  for (const account of candidates) {
    const index = authIndex(account);
    if (index === null) continue;
    let quota: XaiQuota | null = null;
    try {
      quota = await xaiQuota(instance, index);
    } catch {
      // 单账户失败不影响同池其他账户。
    }
    if (!quota || quota.used_pct === null) continue;
    rows.push({
      email: accountEmail(account),
      used_pct: quota.used_pct,
      reset_at: quota.reset_at,
      products: quota.products,
      period_end: quota.period_end,
    });
  }
  const result: Record<string, unknown> = {
    accounts_total: rows.length,
    accounts_usable: rows.length,
  };
  if (rows.length === 0) return result;
  rows.sort((a, b) => b.used_pct - a.used_pct);
  Object.assign(result, rows[0], {
    accounts: rows.map((row) => ({
      email: row.email,
      used: row.used_pct,
      reset_at: row.reset_at,
    })),
  });
  return result;
}

export async function collectAntigravity(
  instance: InstanceConfig,
  accounts: AccountRecord[],
): Promise<ProviderQuota> {
  const candidates = enabledAccounts(accounts, "antigravity");
  const rows: Array<{
    email: string | null;
    plan: null;
    windows: QuotaWindow[];
    used: number;
  }> = [];
  for (const account of candidates) {
    const index = authIndex(account);
    if (index === null) continue;
    let quota: CodexQuota | null = null;
    try {
      quota = await antigravityQuota(
        instance,
        index,
        nullableString(account.project_id),
      );
    } catch {
      // 单账户失败不影响同池其他账户。
    }
    if (!quota || quota.windows.length === 0) continue;
    const weekly = quota.windows.reduce((best, window) =>
      (window.seconds ?? 0) > (best.seconds ?? 0) ? window : best,
    );
    rows.push({
      email: accountEmail(account),
      plan: null,
      windows: quota.windows,
      used: weekly.used,
    });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.used - a.used);
  const best = rows[0];
  return {
    email: best.email,
    plan: null,
    windows: best.windows,
    accounts_total: candidates.length,
    accounts_usable: rows.length,
    accounts: rows.map((row) => ({
      email: row.email,
      windows: row.windows,
    })),
  };
}

export async function collectClaude(
  _instance: InstanceConfig,
  accounts: AccountRecord[],
): Promise<ProviderQuota> {
  const candidates = enabledAccounts(accounts, "claude");
  const rows: Array<{
    email: string | null;
    plan: string | null;
    windows: QuotaWindow[];
    used: number;
  }> = [];
  for (const account of candidates) {
    const quota = claudeQuota(account);
    if (!quota || quota.windows.length === 0) continue;
    const weekly = quota.windows.reduce((best, window) =>
      (window.seconds ?? 0) > (best.seconds ?? 0) ? window : best,
    );
    rows.push({
      email: accountEmail(account),
      plan: quota.plan,
      windows: quota.windows,
      used: weekly.used,
    });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.used - a.used);
  const best = rows[0];
  return {
    email: best.email,
    plan: best.plan,
    windows: best.windows,
    accounts_total: candidates.length,
    accounts_usable: rows.length,
    accounts: rows.map((row) => ({
      email: row.email,
      windows: row.windows,
    })),
  };
}

const COLLECTORS: Record<
  Provider,
  (instance: InstanceConfig, accounts: AccountRecord[]) => Promise<ProviderQuota>
> = {
  codex: collectCodex,
  xai: collectXai,
  antigravity: collectAntigravity,
  claude: collectClaude,
};

export async function collect(config: EffectiveConfig): Promise<CacheV2> {
  const result: CacheV2 = {
    schema_version: 2,
    updated_at: Math.floor(Date.now() / 1000),
    instances: {},
  };
  for (const [baseUrl, instance] of config.instances) {
    const node: InstanceQuota = {};
    for (const provider of instance.providers) node[provider] = null;
    try {
      const accounts = await listAccounts(instance);
      for (const provider of instance.providers) {
        node[provider] = await COLLECTORS[provider](instance, accounts);
      }
    } catch (error) {
      console.error(
        `${baseUrl} collect failed: ${error instanceof Error ? error.name : "Error"}: ${errorMessage(error)}`,
      );
    }
    result.instances[baseUrl] = node;
  }
  return result;
}

function hasQuota(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (Array.isArray(value.windows) && value.windows.length > 0) ||
    typeof value.reset_at === "number"
  );
}

export function cacheInstancesView(value: unknown): Record<string, InstanceQuota> {
  if (!isRecord(value)) return {};
  if (value.schema_version === 2 && isRecord(value.instances)) {
    return value.instances as Record<string, InstanceQuota>;
  }
  const result: Record<string, InstanceQuota> = {};
  for (const spec of LEGACY_SPECS) {
    const node = value[spec.cacheKey];
    if (isRecord(node)) result[spec.baseUrl] = node as InstanceQuota;
  }
  return result;
}

export function applyStaleFallback(
  result: CacheV2,
  oldValue: unknown,
  config: EffectiveConfig,
): CacheV2 {
  const oldInstances = cacheInstancesView(oldValue);
  for (const [baseUrl, instance] of config.instances) {
    for (const provider of instance.providers) {
      const current = result.instances[baseUrl]?.[provider];
      const previous = oldInstances[baseUrl]?.[provider];
      if (!hasQuota(current) && hasQuota(previous)) {
        result.instances[baseUrl] ??= {};
        result.instances[baseUrl][provider] = {
          ...(previous as Record<string, unknown>),
          stale: true,
        };
      }
    }
  }
  return result;
}

async function readCache(paths: RuntimePaths): Promise<unknown> {
  if (!(await pathExists(paths.cache))) return null;
  await assertSecureRegularFile(paths.cache, paths.cache, true);
  try {
    return JSON.parse(await readFile(paths.cache, "utf8"));
  } catch {
    return null;
  }
}

export async function atomicWriteJson0600(
  path: string,
  value: unknown,
): Promise<void> {
  if (await pathExists(path)) {
    await assertSecureRegularFile(path, path, true);
  }
  const temp = `${path}.tmp.${process.pid}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function migrateConfig(paths = runtimePaths()): Promise<void> {
  if (await pathExists(paths.config)) {
    throw new Error(`refusing to overwrite existing config: ${paths.config}`);
  }
  const legacy = await loadLegacyConfig(paths);
  const instances: Record<string, unknown> = {};
  for (const [baseUrl, instance] of legacy.instances) {
    instances[baseUrl] = {
      management_key: instance.managementKey,
      providers: instance.providers,
    };
  }
  await atomicWriteJson0600(paths.config, { version: 1, instances });
  console.log(`created ${paths.config}`);
  console.log(`migrated ${legacy.instances.size} instance(s); legacy key files kept`);
}

export async function checkConfig(paths = runtimePaths()): Promise<void> {
  const configExists = await pathExists(paths.config);
  const config = await loadConfig(paths, true);
  console.log(`config: ${configExists ? paths.config : "legacy key files"}`);
  console.log(`mode: ${config.source}`);
  console.log(`instances: ${config.instances.size}`);
  for (const instance of config.instances.values()) {
    console.log(`- base_url: ${instance.baseUrl}`);
    console.log(`  management_url: ${instance.managementUrl}`);
    console.log(`  management_key: set`);
    console.log(`  providers: ${instance.providers.join(",")}`);
    if (instance.managementUrl.startsWith("http://")) {
      console.log("  warning: HTTP transmits the management bearer key in cleartext");
    }
  }
  if (!configExists) {
    console.log("warning: legacy key files are deprecated; run --migrate-config");
  }
  console.log("config valid");
}

export async function runCollection(
  paths = runtimePaths(),
  print = false,
): Promise<number> {
  try {
    const config = await loadConfig(paths, true);
    if (config.source === "legacy") {
      console.error("legacy key files are deprecated; run --migrate-config");
    }
    const result = await collect(config);
    const oldValue = await readCache(paths);
    applyStaleFallback(result, oldValue, config);
    await atomicWriteJson0600(paths.cache, result);
    if (print) console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`cliproxy-quota failed: ${errorMessage(error)}`);
    return 1;
  }
}

export async function main(args = Bun.argv.slice(2)): Promise<number> {
  try {
    if (args.includes("--migrate-config")) {
      await migrateConfig();
      return 0;
    }
    if (args.includes("--check-config")) {
      await checkConfig();
      return 0;
    }
    return runCollection(runtimePaths(), args.includes("--print"));
  } catch (error) {
    console.error(`cliproxy-quota failed: ${errorMessage(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
