import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravityQuota,
  applyStaleFallback,
  atomicWriteJson0600,
  cacheInstancesView,
  checkConfig,
  claudeQuota,
  codexQuota,
  isoEpoch,
  loadConfig,
  migrateConfig,
  normalizeBaseUrl,
  type CacheV2,
  type EffectiveConfig,
  type InstanceConfig,
  type RuntimePaths,
  xaiQuota,
} from "../cliproxy-quota";

let root: string;
let paths: RuntimePaths;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cc-status-line-"));
  paths = {
    claudeDir: root,
    config: join(root, "cliproxy-config.json"),
    cache: join(root, "cliproxy-quota.json"),
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
});

async function writeSecure(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function instance(): InstanceConfig {
  return {
    baseUrl: "https://cpa.example",
    managementUrl: "https://cpa.example/v0/management",
    managementKey: "test-management-key",
    providers: ["codex", "xai", "antigravity"],
  };
}

function mockApiCall(upstreamBody: unknown, statusCode = 200): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status_code: statusCode,
        body: JSON.stringify(upstreamBody),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
}

describe("config", () => {
  test("loads base-url keyed instances and defaults providers", async () => {
    await writeSecure(
      paths.config,
      JSON.stringify({
        version: 1,
        instances: {
          "https://cpa.example/": {
            management_key: "secret",
          },
        },
      }),
    );

    const config = await loadConfig(paths, false);
    expect(config.source).toBe("config");
    expect([...config.instances.keys()]).toEqual(["https://cpa.example"]);
    expect(config.instances.get("https://cpa.example")?.providers).toEqual([
      "codex",
      "xai",
      "antigravity",
      "claude",
    ]);
  });

  test("rejects unknown providers and insecure permissions", async () => {
    await writeSecure(
      paths.config,
      JSON.stringify({
        version: 1,
        instances: {
          "https://cpa.example": {
            management_key: "secret",
            providers: ["unknown"],
          },
        },
      }),
    );
    await expect(loadConfig(paths, false)).rejects.toThrow("supported values");

    await writeSecure(
      paths.config,
      JSON.stringify({
        version: 1,
        instances: {
          "https://cpa.example": { management_key: "secret" },
        },
      }),
    );
    await chmod(paths.config, 0o644);
    await expect(loadConfig(paths, false)).rejects.toThrow("permissions");
  });

  test("normalizes only trailing slashes and rejects unsafe URLs", () => {
    expect(normalizeBaseUrl("https://cpa.example///")).toBe(
      "https://cpa.example",
    );
    expect(() => normalizeBaseUrl("https://user:pass@cpa.example")).toThrow(
      "credentials",
    );
    expect(() => normalizeBaseUrl("file:///tmp/cpa")).toThrow("http and https");
  });

  test("migrates legacy key files without printing keys", async () => {
    const firstKey = "legacy-secret-one";
    const secondKey = "legacy-secret-two";
    await writeSecure(join(root, ".cliproxy-mgmt-key"), firstKey);
    await writeSecure(join(root, ".earnrmb-mgmt-key"), secondKey);
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.join(" "));
    });

    await migrateConfig(paths);
    log.mockRestore();

    const mode = (await stat(paths.config)).mode & 0o777;
    expect(mode).toBe(0o600);
    const text = await readFile(paths.config, "utf8");
    expect(text).toContain(firstKey);
    expect(text).toContain(secondKey);
    expect(output.join("\n")).not.toContain(firstKey);
    expect(output.join("\n")).not.toContain(secondKey);
    expect(await readFile(join(root, ".cliproxy-mgmt-key"), "utf8")).toBe(
      firstKey,
    );
  });

  test("check-config prints only a redacted key marker", async () => {
    const key = "never-print-this-secret";
    await writeSecure(
      paths.config,
      JSON.stringify({
        version: 1,
        instances: {
          "https://cpa.example": { management_key: key },
        },
      }),
    );
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.join(" "));
    });
    await checkConfig(paths);
    log.mockRestore();
    expect(output.join("\n")).toContain("management_key: set");
    expect(output.join("\n")).not.toContain(key);
  });
});

describe("provider parsing", () => {
  test("parses Codex windows", async () => {
    mockApiCall({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          limit_window_seconds: 18000,
          used_percent: 25,
          reset_at: 1000,
        },
        secondary_window: {
          limit_window_seconds: 604800,
          used_percent: 50,
          reset_at: 2000,
        },
      },
    });
    const quota = await codexQuota(instance(), "auth-1");
    expect(quota).toEqual({
      plan: "pro",
      windows: [
        { seconds: 18000, used: 25, reset_at: 1000 },
        { seconds: 604800, used: 50, reset_at: 2000 },
      ],
    });
  });

  test("ignores XAI accounts without creditUsagePercent", async () => {
    mockApiCall({
      config: {
        currentPeriod: { end: "2026-08-20T00:00:00Z" },
        productUsage: [],
      },
    });
    const quota = await xaiQuota(instance(), "auth-1");
    expect(quota?.used_pct).toBeNull();
  });

  test("parses Antigravity Gemini 5h and weekly windows", async () => {
    mockApiCall({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              remainingFraction: 0.75,
              resetTime: "2026-08-20T00:00:00Z",
            },
            {
              bucketId: "gemini-5h",
              remainingFraction: 0.25,
              resetTime: "2026-08-18T12:00:00Z",
            },
          ],
        },
      ],
    });
    const quota = await antigravityQuota(
      instance(),
      "auth-1",
      "project-id",
    );
    expect(quota?.windows.map(({ seconds, used }) => ({ seconds, used }))).toEqual([
      { seconds: 604800, used: 25 },
      { seconds: 18000, used: 75 },
    ]);
  });

  test("parses Claude unified rate-limit signals from auth-files", () => {
    const quota = claudeQuota({
      provider: "claude",
      auth_index: "auth-1",
      account_type: "oauth",
      quota: {
        signals: {
          "Anthropic-Ratelimit-Unified-5h-Utilization": "0.45",
          "Anthropic-Ratelimit-Unified-5h-Reset": "1788762000",
          "Anthropic-Ratelimit-Unified-7d-Utilization": "0.15",
          "Anthropic-Ratelimit-Unified-7d-Reset": "1788998400",
        },
      },
    });
    expect(quota).toEqual({
      plan: "oauth",
      windows: [
        { seconds: 18000, used: 45, reset_at: 1788762000 },
        { seconds: 604800, used: 15, reset_at: 1788998400 },
      ],
    });
  });

  test("ignores Claude accounts without usable signals", () => {
    expect(
      claudeQuota({ provider: "claude", auth_index: "auth-1" }),
    ).toBeNull();
    expect(
      claudeQuota({
        provider: "claude",
        auth_index: "auth-1",
        quota: { signals: { "Anthropic-Ratelimit-Unified-Status": "allowed" } },
      }),
    ).toBeNull();
  });

  test("converts ISO timestamps to epoch seconds", () => {
    expect(isoEpoch("1970-01-01T00:00:01Z")).toBe(1);
    expect(isoEpoch("invalid")).toBeNull();
    expect(isoEpoch(null)).toBeNull();
  });
});

describe("cache", () => {
  test("reads v2 and legacy instance views", () => {
    expect(
      Object.keys(
        cacheInstancesView({
          schema_version: 2,
          instances: { "https://cpa.example": { xai: {} } },
        }),
      ),
    ).toEqual(["https://cpa.example"]);
    expect(
      Object.keys(cacheInstancesView({ pad: { codex: { windows: [{}] } } })),
    ).toEqual(["http://pad.gf.com.cn:8317"]);
  });

  test("stale fallback only restores configured providers", () => {
    const config: EffectiveConfig = {
      version: 1,
      source: "config",
      instances: new Map([
        [
          "https://cpa.example",
          {
            ...instance(),
            providers: ["xai"],
          },
        ],
      ]),
    };
    const result: CacheV2 = {
      schema_version: 2,
      updated_at: 1,
      instances: { "https://cpa.example": { xai: null } },
    };
    applyStaleFallback(
      result,
      {
        schema_version: 2,
        instances: {
          "https://cpa.example": {
            xai: { reset_at: 100, accounts: [], stale: false },
            codex: { windows: [{ used: 10 }] },
          },
        },
      },
      config,
    );
    expect(result.instances["https://cpa.example"].xai?.stale).toBe(true);
    expect(result.instances["https://cpa.example"].codex).toBeUndefined();
  });

  test("writes JSON atomically with mode 0600", async () => {
    await atomicWriteJson0600(paths.cache, { ok: true });
    expect(JSON.parse(await readFile(paths.cache, "utf8"))).toEqual({ ok: true });
    expect((await stat(paths.cache)).mode & 0o777).toBe(0o600);
  });
});
