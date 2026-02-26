import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/dashboard/server.ts"],
  outDir: "dist",
  format: "esm",
  clean: true,
  platform: "node",
  target: "node20",
  noExternal: [/^zod/],
  external: [/^@anthropic-ai\/claude-agent-sdk/],
});
