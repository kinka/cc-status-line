import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const statusline = resolve(import.meta.dir, "../statusline-command.sh");
let home: string;
let claudeDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cc-statusline-home-"));
  claudeDir = join(home, ".claude");
  await mkdir(claudeDir);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

async function render(
  baseUrl: string,
  modelId: string,
  displayName: string,
  columns = 500,
  env: Record<string, string> = {},
): Promise<string> {
  const input = JSON.stringify({
    cwd: home,
    model: { id: modelId, display_name: displayName },
    context_window: { remaining_percentage: 80 },
  });
  const result = Bun.spawnSync({
    cmd: ["sh", statusline],
    stdin: Buffer.from(input),
    env: {
      ...process.env,
      HOME: home,
      ANTHROPIC_BASE_URL: baseUrl,
      COLUMNS: String(columns),
      ...env,
    },
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

function gemQuota(email: string, used5h: number, used7d: number) {
  const now = Math.floor(Date.now() / 1000);
  return {
    email,
    windows: [
      { seconds: 18000, used: used5h, reset_at: now + 3600 },
      { seconds: 604800, used: used7d, reset_at: now + 86400 },
    ],
  };
}

async function writeCache(value: unknown): Promise<void> {
  await writeFile(join(claudeDir, "cliproxy-quota.json"), JSON.stringify(value));
}

describe("base URL routing", () => {
  test("same provider reads independent pools by exact base URL", async () => {
    await writeCache({
      schema_version: 2,
      updated_at: Math.floor(Date.now() / 1000),
      instances: {
        "https://cpa-a.example": {
          antigravity: {
            accounts: [gemQuota("first@example.com", 10, 20)],
          },
        },
        "https://cpa-b.example": {
          antigravity: {
            accounts: [gemQuota("second@example.com", 30, 40)],
          },
        },
      },
    });

    const first = stripAnsi(
      await render("https://cpa-a.example/", "gemini-flash", "Gemini"),
    );
    const second = stripAnsi(
      await render("https://cpa-b.example", "gemini-flash", "Gemini"),
    );
    expect(first).toContain("first");
    expect(first).not.toContain("second");
    expect(second).toContain("second");
    expect(second).not.toContain("first");
  });

  test("unknown and lookalike URLs fail closed", async () => {
    await writeCache({
      schema_version: 2,
      updated_at: Math.floor(Date.now() / 1000),
      instances: {
        "https://cpa.example": {
          antigravity: {
            accounts: [gemQuota("private@example.com", 10, 20)],
          },
        },
      },
    });

    const unknown = stripAnsi(
      await render("https://cpa.example.evil.test", "gemini-flash", "Gemini"),
    );
    expect(unknown).not.toContain("| gem");
    expect(unknown).not.toContain("private");
  });

  test("reads legacy cache only for exact historical URL", async () => {
    await writeCache({
      updated_at: Math.floor(Date.now() / 1000),
      pad: {
        xai: {
          accounts: [
            {
              email: "legacy@example.com",
              used: 40,
              reset_at: Math.floor(Date.now() / 1000) + 86400,
            },
          ],
        },
      },
    });

    const matched = stripAnsi(
      await render(
        "http://pad.gf.com.cn:8317",
        "grok-code-fast-1",
        "Grok",
      ),
    );
    const unknown = stripAnsi(
      await render("http://pad.gf.com.cn.evil:8317", "grok-code-fast-1", "Grok"),
    );
    expect(matched).toContain("legacy");
    expect(unknown).not.toContain("legacy");
  });
});

describe("rendering", () => {
  test("wraps only between complete account segments", async () => {
    await writeCache({
      schema_version: 2,
      updated_at: Math.floor(Date.now() / 1000),
      instances: {
        "https://cpa.example": {
          antigravity: {
            accounts: [
              gemQuota("account1@example.com", 10, 20),
              gemQuota("account2@example.com", 30, 40),
              gemQuota("account3@example.com", 50, 60),
            ],
          },
        },
      },
    });

    const output = stripAnsi(
      await render("https://cpa.example", "gemini-flash", "Gemini", 100),
    );
    const lines = output.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    expect(output).toMatch(/account1 5h:90%.* 7d:80%/);
    expect(output).toMatch(/account2 5h:70%.* 7d:60%/);
    expect(output).toMatch(/account3 5h:50%.* 7d:40%/);
  });

  test("renders XAI weekly and Codex real windows", async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeCache({
      schema_version: 2,
      updated_at: now,
      instances: {
        "https://cpa.example": {
          xai: {
            accounts: [
              { email: "grok@example.com", used: 25, reset_at: now + 86400 },
            ],
          },
          codex: {
            accounts: [
              {
                email: "gpt@example.com",
                windows: [
                  { seconds: 604800, used: 35, reset_at: now + 86400 },
                ],
              },
            ],
          },
        },
      },
    });

    const grok = stripAnsi(
      await render("https://cpa.example", "grok-4", "Grok"),
    );
    const gpt = stripAnsi(
      await render("https://cpa.example", "gpt-5-codex", "GPT"),
    );
    expect(grok).toContain("grok wk:75%");
    expect(gpt).toContain("gpt 7d:65%");
    expect(gpt).not.toContain("5h:");
  });
});

describe("config dir and refresh throttle", () => {
  test("reads cache from CLAUDE_CONFIG_DIR when set", async () => {
    const altDir = await mkdtemp(join(tmpdir(), "cc-statusline-alt-"));
    try {
      await writeFile(
        join(altDir, "cliproxy-quota.json"),
        JSON.stringify({
          schema_version: 2,
          updated_at: Math.floor(Date.now() / 1000),
          instances: {
            "https://cpa.example": {
              antigravity: {
                accounts: [gemQuota("alt-dir@example.com", 10, 20)],
              },
            },
          },
        }),
      );
      await writeCache({
        schema_version: 2,
        updated_at: Math.floor(Date.now() / 1000),
        instances: {
          "https://cpa.example": {
            antigravity: {
              accounts: [gemQuota("home-dir@example.com", 10, 20)],
            },
          },
        },
      });

      const out = stripAnsi(
        await render("https://cpa.example", "gemini-flash", "Gemini", 500, {
          CLAUDE_CONFIG_DIR: altDir,
        }),
      );
      expect(out).toContain("alt-dir");
      expect(out).not.toContain("home-dir");
    } finally {
      await rm(altDir, { recursive: true, force: true });
    }
  });

  test("legacy schema only spawns collector once per TTL", async () => {
    const collector = join(claudeDir, "cliproxy-quota.ts");
    const counter = join(claudeDir, "collector-runs.txt");
    await writeFile(
      collector,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(counter)}, "1\\n");`,
        "await Bun.sleep(50);",
      ].join("\n"),
    );
    await writeCache({
      updated_at: Math.floor(Date.now() / 1000),
      pad: {
        antigravity: {
          accounts: [gemQuota("legacy@example.com", 10, 20)],
        },
      },
    });

    await render("http://pad.gf.com.cn:8317", "gemini-flash", "Gemini");
    await render("http://pad.gf.com.cn:8317", "gemini-flash", "Gemini");
    await Bun.sleep(120);

    const runs = await Bun.file(counter)
      .text()
      .then((text) => text.trim().split("\n").filter(Boolean).length)
      .catch(() => 0);
    expect(runs).toBe(1);
  });
});
