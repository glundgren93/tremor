import type { ChaosPreset } from "./types";

/**
 * Resource types for server-side fault presets.
 * These presets simulate backend/API failures, not network-level issues,
 * so they only target dynamic requests (xhr/fetch), leaving static assets
 * (CSS, JS, fonts, images) and the HTML document unaffected — matching
 * real-world behavior where a CDN serves static assets independently.
 */
const API_RESOURCE_TYPES = ["xhr", "fetch"];

export const PRESETS: ChaosPreset[] = [
  {
    id: "backend-down",
    name: "Backend Down",
    description: "100% 503 on API requests (static assets and document unaffected)",
    rules: [
      {
        name: "Backend Down — API requests",
        enabled: true,
        match: { urlPattern: "**", resourceTypes: API_RESOURCE_TYPES },
        effects: [{ type: "error", status: 503, rate: 1.0 }],
      },
    ],
  },
  {
    id: "slow-network",
    name: "Slow Network",
    description: "~1.5s latency on all requests (normal distribution, models network-level degradation)",
    rules: [
      {
        name: "Slow Network — all requests",
        enabled: true,
        match: { urlPattern: "**" },
        effects: [{ type: "latency", ms: 1500, distribution: "normal" }],
      },
    ],
  },
  {
    id: "flaky",
    name: "Flaky API",
    description: "20% random failure rate on API requests",
    rules: [
      {
        name: "Flaky — random 500s",
        enabled: true,
        match: { urlPattern: "**", resourceTypes: API_RESOURCE_TYPES },
        effects: [{ type: "error", status: 500, rate: 0.2 }],
      },
    ],
  },
  {
    id: "timeout-chaos",
    name: "Timeout Chaos",
    description: "30% of API requests time out after 5s (static assets unaffected)",
    rules: [
      {
        name: "Timeout — random aborts",
        enabled: true,
        match: { urlPattern: "**", resourceTypes: API_RESOURCE_TYPES },
        effects: [{ type: "timeout", rate: 0.3, afterMs: 5000 }],
      },
    ],
  },
  {
    id: "empty-response",
    name: "Empty Response",
    description: "API requests return 200 OK with empty JSON body (tests response shape validation)",
    rules: [
      {
        name: "Empty Response — 200 with empty body",
        enabled: true,
        match: { urlPattern: "**", resourceTypes: API_RESOURCE_TYPES },
        effects: [{ type: "mock", status: 200, body: "{}", rate: 1.0 }],
      },
    ],
  },
  {
    id: "auth-cascade",
    name: "Auth Cascade",
    description: "60% of API requests return 401 Unauthorized (simulates auth service failure)",
    rules: [
      {
        name: "Auth Cascade — 401s on API requests",
        enabled: true,
        match: { urlPattern: "**", resourceTypes: API_RESOURCE_TYPES },
        effects: [{ type: "error", status: 401, rate: 0.6 }],
      },
    ],
  },
];
