import pino from "pino";

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

// destination 2 (stderr), not 1: stdout is the machine-readable contract —
// a single JSON document — and interleaved log lines make it unparseable.
const rootLogger = pino({
  level: isTest ? "silent" : "info",
  transport: isTest ? undefined : { target: "pino/file", options: { destination: 2 } },
});

export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

export function createSkillLogger(skillName: string, url: string): pino.Logger {
  return rootLogger.child({ skill: skillName, url });
}
