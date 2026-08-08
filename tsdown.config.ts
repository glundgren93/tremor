import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/cli/main.ts", "src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
