---
description: Deep test a single endpoint with 6 fault types
argument-hint: <url>
---

You are a frontend resilience testing specialist. Deep test a single endpoint on **$ARGUMENTS**.

## Phase 1: Discover the Endpoint

1. `browser_launch` with the target URL
2. `network_wait_idle` — wait for the page to fully load
3. `network_get_requests` — inspect captured traffic

Identify the primary API endpoint (the most important data-fetching request). If there are multiple, pick the one that provides the main content for the page.

Report which endpoint you've selected: `METHOD /path`

## Phase 2: Test 6 Fault Types

For each fault, use `fault_apply_custom` with the endpoint's URL pattern. Follow this exact sequence per fault:

1. `fault_reset` — clear previous faults
2. `fault_apply_custom` — apply the fault (see below)
3. `browser_navigate` — reload the page
4. `network_wait_idle` — wait for requests to settle
5. `browser_screenshot` — capture the result
6. Evaluate and call `report_add_finding`

### The 6 Faults

**1. Server Error (500)**
```
urlPattern: "**/api/endpoint-path*"
response: { status: 500, body: "{\"error\": \"Internal Server Error\"}" }
```

**2. Timeout (30s)**
```
urlPattern: "**/api/endpoint-path*"
effect: { type: "timeout", rate: 1.0 }
```

**3. Empty Response**
```
urlPattern: "**/api/endpoint-path*"
response: { status: 200, body: "[]" }  (or "{}" if not a list endpoint)
```

**4. Malformed JSON**
```
urlPattern: "**/api/endpoint-path*"
response: { status: 200, body: "{malformed json<>>" }
```

**5. Rate Limited (429)**
```
urlPattern: "**/api/endpoint-path*"
response: { status: 429, body: "{\"error\": \"Too Many Requests\"}" }
```

**6. Not Found (404)**
```
urlPattern: "**/api/endpoint-path*"
response: { status: 404, body: "{\"error\": \"Not Found\"}" }
```

Adapt the `urlPattern` to match the actual endpoint you discovered. Use glob patterns (e.g., `**/api/users*`).

## Severity Definitions

- **Critical**: Blank/white screen, app crash, infinite loading with no feedback, completely broken layout
- **Major**: Page shell loads but critical data missing with no error message, stuck spinners, broken interactive elements
- **Minor**: Poor error message wording, layout shifts, missing non-critical data, raw error text without styled UI
- **Good**: Graceful error handling, retry buttons, fallback content, helpful error messages, proper error boundaries

## Finish

1. `fault_reset` — clean up
2. `report_export` — export the report

Print a detailed summary:

```
Endpoint: METHOD /path

| Fault          | Severity | What Happened                     |
|----------------|----------|-----------------------------------|
| 500 Error      | ...      | ...                               |
| Timeout        | ...      | ...                               |
| Empty Response | ...      | ...                               |
| Malformed JSON | ...      | ...                               |
| 429 Rate Limit | ...      | ...                               |
| 404 Not Found  | ...      | ...                               |

Score: X/100
```

Score = average of severity weights: critical=0, major=30, minor=70, good=100.
