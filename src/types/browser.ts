import type { BrowserContext, Page } from "playwright";
import { z } from "zod/v4";

export const BrowserConfigSchema = z.object({
  url: z.url(),
  headless: z.boolean().default(true),
  videoDir: z.string().optional(),
  videoSize: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .default({ width: 1280, height: 720 }),
  timeout: z.number().int().positive().default(30_000),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).default("load"),
});

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export type BrowserSession = {
  page: Page;
  context: BrowserContext;
  videoDir: string;
  cleanup(): Promise<void>;
};

export type AuthCallback = (page: Page) => Promise<void>;

export type ScreenshotResult = {
  path: string;
  buffer: Buffer;
};

export type AuthOptions = {
  loginUrl?: string;
  timeout?: number;
};

export type ScreenshotOptions = {
  outputDir: string;
  name?: string;
  fullPage?: boolean;
};

export type NavigateOptions = {
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  timeout?: number;
};
