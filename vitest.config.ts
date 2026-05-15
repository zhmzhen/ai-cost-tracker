import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["test/unit/**/*.spec.ts"],
    setupFiles: ["./test/setup.ts"],
    // The 2 GiB sparse-file test in readDbWithFallback.spec.ts actually
    // allocates and writes a 2.05 GiB Buffer (sparse on disk, dense in
    // memory), which takes roughly 8 s on the developer machine. Give
    // CI plenty of headroom; the default 5 s would flake everywhere.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/extension.ts"],
    },
  },
});
