import { defineConfig } from "vitest/config";

export const mockIsolatedFiles = [
  "test/core/config-atomic.test.ts",
  "test/core/hash-store-open-errors.test.ts",
  "test/core/hash-store-prune-errors.test.ts",
  "test/core/validation-access.test.ts",
  "test/tools/fs-write.cleanup.test.ts",
  "test/tools/fs-write-cleanup-on-error.test.ts",
  "test/tools/fs-write.permissions.test.ts",
];

export const heavyTestFiles = [
  "test/core/hashline-stress.test.ts",
  "test/core/hashline-fuzz-autofix.test.ts",
  "test/core/hashline-property.test.ts",
  "test/core/hashline-limit.test.ts",
  "test/core/hashline-stable-mapping.test.ts",
];

export function buildTestConfig(extraExcludes: string[] = []) {
  return defineConfig({
    test: {
      projects: [
        {
          test: {
            name: "mock-isolated",
            include: mockIsolatedFiles,
            isolate: true,
          },
        },
        {
          test: {
            name: "shared",
            include: ["test/**/*.test.ts"],
            exclude: [...mockIsolatedFiles, ...extraExcludes],
            isolate: false,
          },
        },
      ],
    },
  });
}

export default buildTestConfig();
