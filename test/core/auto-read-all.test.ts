import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { autoReadAllBudget, buildAutoReadAllInjection, discoverAutoReadAllFiles } from "../../src/auto-read-all";
import { ownersForPath, servedForPath } from "../../src/anchor-registry";
import { resolveTarget } from "../../src/fs-write";
import { makeTempDir, rmRetry, withHome } from "../support/fixtures";

const restoreHome = withHome(process.env.HOME);

afterAll(restoreHome);

async function cleanupCwd(cwd: string): Promise<void> {
  await rmRetry(cwd);
}

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
}

describe("discoverAutoReadAllFiles", () => {
  it("lists tracked and untracked files while skipping ignored, binary, image, and oversized files", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-git-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "tracked.ts"), "export const a = 1;\n");
      execFileSync("git", ["add", "tracked.ts"], { cwd });
      await writeFile(join(cwd, "untracked.md"), "# hi\n");
      await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
      await writeFile(join(cwd, "ignored.txt"), "nope\n");
      await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      await writeFile(join(cwd, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
      await writeFile(join(cwd, "huge.txt"), "x".repeat(250_000));

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.source).toBe("git");
      expect(discovery.files).toEqual([".gitignore", "tracked.ts", "untracked.md"]);
      expect(discovery.discovered).toBe(6);
      expect(discovery.skippedBinary).toBe(2);
      expect(discovery.skippedLarge).toBe(1);
      expect(discovery.skippedOther).toBe(0);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("falls back to ripgrep outside a git repository and honors .gitignore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hashline-auto-read-all-rg-"));
    try {
      await writeFile(join(cwd, "keep.txt"), "keep\n");
      await writeFile(join(cwd, ".gitignore"), "secret.txt\n");
      await writeFile(join(cwd, "secret.txt"), "no\n");

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.source).toBe("rg");
      expect(discovery.files).toEqual([".gitignore", "keep.txt"]);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("skips tracked files that are missing from the working tree", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-deleted-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "gone.txt"), "gone\n");
      execFileSync("git", ["add", "gone.txt"], { cwd });
      await rm(join(cwd, "gone.txt"));

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.files).toEqual([]);
      expect(discovery.skippedOther).toBe(1);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("lists git files in git mode", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-gitmode-git-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "tracked.ts"), "export const a = 1;\n");
      await writeFile(join(cwd, "untracked.md"), "# hi\n");
      execFileSync("git", ["add", "tracked.ts"], { cwd });

      const discovery = await discoverAutoReadAllFiles(cwd, "git");
      expect(discovery.source).toBe("git");
      expect(discovery.files).toEqual(["tracked.ts", "untracked.md"]);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("returns no files in git mode outside a git repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hashline-auto-read-all-gitmode-"));
    try {
      await writeFile(join(cwd, "keep.txt"), "keep\n");
      const discovery = await discoverAutoReadAllFiles(cwd, "git");
      expect(discovery.source).toBe("git");
      expect(discovery.files).toEqual([]);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("skips package-lock.json anywhere in the tree", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-lock-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "package-lock.json"), "{}\n");
      await mkdir(join(cwd, "sub"));
      await writeFile(join(cwd, "sub", "package-lock.json"), "{}\n");
      await writeFile(join(cwd, "keep.ts"), "export const a = 1;\n");

      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.files).toEqual(["keep.ts"]);
      expect(discovery.discovered).toBe(3);
      expect(discovery.skippedByName).toBe(2);

      const injection = await buildAutoReadAllInjection(cwd, 1_000_000);
      expect(injection).toBeDefined();
      expect(injection!.text).toContain("=== keep.ts ===");
      expect(injection!.text).not.toContain("=== package-lock.json ===");
      expect(injection!.text).not.toContain("=== sub/package-lock.json ===");
      expect(injection!.text).toContain("2 file(s) skipped by vendor/name/pattern rules");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("skips Tier 1 vendored segments case-insensitively", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-vendor-");
    try {
      initGitRepo(cwd);
      const segments = ["vendor", "node_modules", "bower_components", "third_party", "thirdparty", "jspm_packages", ".venv", "venv", "site-packages", "__pycache__", ".tox", ".gradle", ".terraform", "Pods", "Carthage", "DerivedData", "coreui", "coreui-icons"];
      await writeFile(join(cwd, "keep.ts"), "export const a = 1;\n");
      await writeFile(join(cwd, "vendor_notes.txt"), "notes\n");
      for (const segment of segments) {
        await mkdir(join(cwd, segment), { recursive: true });
        await writeFile(join(cwd, segment, "skipped.ts"), "export const a = 1;\n");
      }
      await mkdir(join(cwd, "Vendor"), { recursive: true });
      await writeFile(join(cwd, "Vendor", "upper.ts"), "export const a = 1;\n");
      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.files).toEqual(["keep.ts", "vendor_notes.txt"]);
      expect(discovery.skippedByName).toBe(segments.length + 1);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("skips all SVG files and coreui folders", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-svg-coreui-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "keep.ts"), "export const a = 1;\n");
      await writeFile(join(cwd, "icon.svg"), "<svg></svg>\n");
      await writeFile(join(cwd, "logo.SVG"), "<svg></svg>\n");
      await mkdir(join(cwd, "resources", "scss", "coreui-icons"), { recursive: true });
      await writeFile(join(cwd, "resources", "scss", "coreui-icons", "icon.scss"), ".icon {}\n");
      await mkdir(join(cwd, "public", "images", "coreui"), { recursive: true });
      await writeFile(join(cwd, "public", "images", "coreui", "logo.png"), "not an image\n");
      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.files).toEqual(["keep.ts"]);
      expect(discovery.skippedBinary).toBeGreaterThanOrEqual(2);
      expect(discovery.skippedByName).toBeGreaterThanOrEqual(2);
      const injection = await buildAutoReadAllInjection(cwd, 1_000_000);
      expect(injection!.text).not.toContain("=== icon.svg ===");
      expect(injection!.text).not.toContain("coreui-icons");
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("skips Tier 3 vendored and generated name patterns", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-patterns-");
    try {
      initGitRepo(cwd);
      const skipped = ["app.min.js", "style.min.css", "lib.min.mjs", "app-min.js", "style-min.css", "vendor.bundle.js", "app.chunk.js", "lib.umd.js", "app.js.map", "custom.lock", "yarn.lock", "composer.lock", "Gemfile.lock", "Cargo.lock", "poetry.lock", "Pipfile.lock", "go.sum", "flake.lock", ".eslintcache", "foo.generated.js", "foo.gen.js", "foo_pb2.py", "foo.pb.go", "foo.g.dart", "foo.freezed.dart", "foo.designer.cs", "foo.g.cs", "foo.snap", "coreui-icons.css", "coreui-icons.linear.css", "coreui.css"];
      await writeFile(join(cwd, "keep.ts"), "export const a = 1;\n");
      await writeFile(join(cwd, "bundle.js"), "export const a = 1;\n");
      await writeFile(join(cwd, "generated.js"), "export const a = 1;\n");
      for (const name of skipped) {
        await writeFile(join(cwd, name), "export const a = 1;\n");
      }
      const discovery = await discoverAutoReadAllFiles(cwd);
      expect(discovery.files).toEqual(["bundle.js", "generated.js", "keep.ts"]);
      expect(discovery.skippedByName).toBe(skipped.length);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("marks complete files", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-markers-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "small.txt"), "alpha\nbeta\n");
      await writeFile(join(cwd, "big.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n") + "\n");
      const injection = await buildAutoReadAllInjection(cwd, 1_000_000);
      expect(injection).toBeDefined();
      expect(injection!.completeFiles).toBe(2);
      expect(injection!.text).toContain("=== small.txt ===");
      expect(injection!.text).not.toContain("[complete,");
      expect(injection!.text).toContain("=== big.txt ===");
      expect(injection!.text).toContain("[coverage: 2 complete]");
      expect(injection!.text).toContain("[files complete:");
    } finally {
      await cleanupCwd(cwd);
    }
  });
});

describe("buildAutoReadAllInjection", () => {
  it("attaches anchored file content and serves the anchors", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-inject-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
      await writeFile(join(cwd, "empty.txt"), "");

      const injection = await buildAutoReadAllInjection(cwd, 1_000_000);
      expect(injection).toBeDefined();
      expect(injection!.files).toBe(2);
      expect(injection!.text).toContain("[hashline auto-read-all]");
      expect(injection!.text).toContain("=== sample.txt ===");
      const anchor = injection!.text.match(/([A-Za-z]{4})│alpha/);
      expect(anchor).not.toBeNull();

      const resolved = await resolveTarget(join(cwd, "sample.txt"));
      expect(ownersForPath(resolved).has(anchor![1]!)).toBe(true);
      expect(servedForPath(resolved)?.has(anchor![1]!)).toBe(true);
    } finally {
      await cleanupCwd(cwd);
    }
  });

  it("stops attaching files once the byte budget is spent", async () => {
    const cwd = await makeTempDir("pi-hashline-auto-read-all-budget-");
    try {
      initGitRepo(cwd);
      await writeFile(join(cwd, "a.txt"), "a\n".repeat(2000));
      await writeFile(join(cwd, "b.txt"), "b\n".repeat(2000));

      const injection = await buildAutoReadAllInjection(cwd, 3000);
      expect(injection).toBeDefined();
      expect(injection!.files).toBe(1);
      expect(injection!.omitted).toEqual(["b.txt"]);
      expect(injection!.text).toContain("Not attached: b.txt");
      const omittedPath = await resolveTarget(join(cwd, "b.txt"));
      expect(ownersForPath(omittedPath).size).toBe(0);
      expect(servedForPath(omittedPath)).toBeUndefined();
    } finally {
      await cleanupCwd(cwd);
    }
  });
});

describe("autoReadAllBudget", () => {
  it("clamps small and unknown context windows to the minimum", () => {
    expect(autoReadAllBudget(undefined)).toBe(200_000);
    expect(autoReadAllBudget({ contextWindow: 128_000 })).toBe(200_000);
  });

  it("scales with the context window", () => {
    expect(autoReadAllBudget({ contextWindow: 400_000 })).toBe(600_000);
  });

  it("clamps very large context windows to the maximum", () => {
    expect(autoReadAllBudget({ contextWindow: 4_000_000 })).toBe(2_000_000);
  });
});
