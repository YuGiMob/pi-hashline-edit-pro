import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, rmRetry, setupIntegrationTest, withHome } from "../support/fixtures";

const restoreHome = withHome(process.env.HOME);

afterAll(restoreHome);

async function cleanupCwd(cwd: string): Promise<void> {
  await rmRetry(cwd);
}

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
}

async function writeConfig(cwd: string, config: Record<string, unknown>): Promise<void> {
  const configDir = join(cwd, ".config", "pi-hashline-edit-pro");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify(config), "utf-8");
}

function sessionContext(cwd: string, branch: unknown[] = []): any {
  return {
    cwd,
    hasUI: false,
    ui: { notify() {} },
    model: { contextWindow: 200_000 },
    sessionManager: { getBranch: () => branch },
  };
}

describe("auto-read all", () => {
  it("is off by default", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-off-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      const { handlers } = setupIntegrationTest(cwd);
      const ctx = sessionContext(cwd);
      await handlers.get("session_start")!({}, ctx);
      expect(await handlers.get("before_agent_start")!({}, ctx)).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("attaches anchored content on the first turn whose anchors edit without read", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-on-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      await writeConfig(cwd, { autoRead: true, anchorGrepEnabled: true, autoReadAll: true });
      const { handlers, getTool } = setupIntegrationTest(cwd);
      const ctx = sessionContext(cwd);
      await handlers.get("session_start")!({}, ctx);

      const first = (await handlers.get("before_agent_start")!({}, ctx)) as { message?: { customType?: string; content?: string } } | undefined;
      expect(first?.message?.customType).toBe("hashline-auto-read-all");
      const content = first!.message!.content as string;
      expect(content).toContain("[hashline auto-read-all]");
      expect(content).toContain("=== sample.txt ===");
      const anchor = content.match(/([A-Za-z]{4})│alpha/)![1]!;
      expect(await handlers.get("before_agent_start")!({}, ctx)).toBeUndefined();

      const editResult = await getTool("replace").execute(
        "e1",
        { remove_from: anchor, remove_to: anchor, replacement_lines: ["ALPHA"] },
        undefined,
        undefined,
        ctx,
      );
      expect(editResult.content[0].text).toContain("Successfully replaced");
      expect(await readFile(join(cwd, "sample.txt"), "utf-8")).toBe("ALPHA\nbeta\n");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("does not inject when the branch already holds the auto-read-all message", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-resume-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\n");
      await writeConfig(cwd, { autoRead: true, anchorGrepEnabled: true, autoReadAll: true });
      const { handlers } = setupIntegrationTest(cwd);
      const ctx = sessionContext(cwd, [{ type: "custom_message", customType: "hashline-auto-read-all" }]);
      await handlers.get("session_start")!({}, ctx);
      expect(await handlers.get("before_agent_start")!({}, ctx)).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("injects in git mode inside a git repository", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-giton-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      await writeConfig(cwd, { autoRead: true, anchorGrepEnabled: true, autoReadAll: "git" });
      const { handlers } = setupIntegrationTest(cwd);
      const ctx = sessionContext(cwd);
      await handlers.get("session_start")!({}, ctx);
      const first = (await handlers.get("before_agent_start")!({}, ctx)) as { message?: { content?: string } } | undefined;
      expect(first?.message?.content).toContain("[hashline auto-read-all]");
      expect(first?.message?.content).toContain("=== sample.txt ===");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("skips injection in git mode outside a git repository", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-gitoff-");
    try {
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      await writeConfig(cwd, { autoRead: true, anchorGrepEnabled: true, autoReadAll: "git" });
      const { handlers } = setupIntegrationTest(cwd);
      const ctx = sessionContext(cwd);
      await handlers.get("session_start")!({}, ctx);
      expect(await handlers.get("before_agent_start")!({}, ctx)).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });
});
