import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/dashboard/prompt";

describe("buildSystemPrompt", () => {
  describe("base case (no presets, no options)", () => {
    const prompt = buildSystemPrompt([]);

    it("includes the identity section", () => {
      expect(prompt).toContain("You are a frontend resilience testing specialist");
    });

    it("includes critical rules", () => {
      expect(prompt).toContain("## Critical Rules");
      expect(prompt).toContain("Do NOT call browser_launch");
    });

    it("includes workflow sections", () => {
      expect(prompt).toContain("### 1. Test Each Scenario");
      expect(prompt).toContain("### 2. Evaluate & Record");
      expect(prompt).toContain("### 3. Navigation Flow Testing");
    });

    it("includes recommendations section", () => {
      expect(prompt).toContain("### 5. Generate Recommendations");
      expect(prompt).toContain("report_add_recommendations");
    });

    it("includes important notes", () => {
      expect(prompt).toContain("## Important Notes");
      expect(prompt).toContain("Test ALL of the listed scenarios");
    });

    it("excludes presets section", () => {
      expect(prompt).not.toContain("### 4. Test Selected Presets");
      expect(prompt).not.toContain("### Understanding Presets");
    });

    it("excludes exploratory section", () => {
      expect(prompt).not.toContain("### 6. Exploratory User-Journey Testing");
      expect(prompt).not.toContain("How to dogfood");
    });

    it("includes non-exploratory notes", () => {
      expect(prompt).toContain("Do NOT add extra tests beyond the curated scenarios");
    });

    it("includes default CPU throttle note", () => {
      expect(prompt).toContain("Use device_set_cpu_throttle to simulate slower devices");
    });

    it("ends with a newline", () => {
      expect(prompt.endsWith("\n")).toBe(true);
    });
  });

  describe("with presets", () => {
    const prompt = buildSystemPrompt(["backend-down", "flaky"]);

    it("includes presets section", () => {
      expect(prompt).toContain("### 4. Test Selected Presets");
    });

    it("lists each preset", () => {
      expect(prompt).toContain('fault_apply_preset with "backend-down"');
      expect(prompt).toContain('fault_apply_preset with "flaky"');
    });

    it("includes understanding presets subsection", () => {
      expect(prompt).toContain("### Understanding Presets");
      expect(prompt).toContain("slow-network");
      expect(prompt).toContain("empty-response");
    });
  });

  describe("with exploratory mode", () => {
    const prompt = buildSystemPrompt([], { exploratory: true });

    it("includes exploratory section", () => {
      expect(prompt).toContain("### 6. Exploratory User-Journey Testing");
    });

    it("includes dogfooding instructions", () => {
      expect(prompt).toContain("#### How to dogfood:");
    });

    it("includes what to look for", () => {
      expect(prompt).toContain("#### What to look for:");
      expect(prompt).toContain("Silent data loss");
    });

    it("includes exploratory tips", () => {
      expect(prompt).toContain("#### Tips:");
      expect(prompt).toContain("fault_apply_custom");
    });

    it("includes exploratory notes instead of fixed-count note", () => {
      expect(prompt).toContain('Record exploratory findings with testType: "exploratory"');
      expect(prompt).not.toContain("Do NOT add extra tests beyond the curated scenarios");
    });
  });

  describe("with CPU throttle rate", () => {
    it("includes active throttle note when rate > 1", () => {
      const prompt = buildSystemPrompt([], { cpuThrottleRate: 4 });
      expect(prompt).toContain("CPU throttle is already active at 4x slowdown");
      expect(prompt).toContain("Do NOT call device_set_cpu_throttle");
      expect(prompt).not.toContain("Use device_set_cpu_throttle to simulate");
    });

    it("includes default throttle note when rate is 1", () => {
      const prompt = buildSystemPrompt([], { cpuThrottleRate: 1 });
      expect(prompt).toContain("Use device_set_cpu_throttle to simulate slower devices");
    });

    it("includes default throttle note when rate is undefined", () => {
      const prompt = buildSystemPrompt([]);
      expect(prompt).toContain("Use device_set_cpu_throttle to simulate slower devices");
    });
  });

  describe("full options", () => {
    const prompt = buildSystemPrompt(["slow-network", "auth-cascade"], {
      exploratory: true,
      cpuThrottleRate: 2,
    });

    it("includes all conditional sections", () => {
      expect(prompt).toContain("### 4. Test Selected Presets");
      expect(prompt).toContain("### 6. Exploratory User-Journey Testing");
    });

    it("includes active CPU throttle note", () => {
      expect(prompt).toContain("CPU throttle is already active at 2x slowdown");
    });

    it("lists the presets", () => {
      expect(prompt).toContain('fault_apply_preset with "slow-network"');
      expect(prompt).toContain('fault_apply_preset with "auth-cascade"');
    });
  });

  describe("snapshots", () => {
    it("matches snapshot for base case", () => {
      expect(buildSystemPrompt([])).toMatchSnapshot();
    });

    it("matches snapshot for full options", () => {
      expect(
        buildSystemPrompt(["backend-down", "flaky"], {
          exploratory: true,
          cpuThrottleRate: 4,
        }),
      ).toMatchSnapshot();
    });
  });
});
