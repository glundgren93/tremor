import { describe, expect, it } from "vitest";
import { createLogger, createSkillLogger } from "../src/logging/logger";

describe("createLogger", () => {
  it("returns a pino logger with module binding", () => {
    const log = createLogger("browser:launch");
    expect(log).toBeDefined();
    expect(log.bindings()).toEqual(expect.objectContaining({ module: "browser:launch" }));
  });

  it("creates distinct child loggers", () => {
    const log1 = createLogger("module-a");
    const log2 = createLogger("module-b");
    expect(log1.bindings().module).toBe("module-a");
    expect(log2.bindings().module).toBe("module-b");
  });
});

describe("createSkillLogger", () => {
  it("returns a logger with skill and url bindings", () => {
    const log = createSkillLogger("regression-check", "https://example.com");
    const bindings = log.bindings();
    expect(bindings.skill).toBe("regression-check");
    expect(bindings.url).toBe("https://example.com");
  });
});
