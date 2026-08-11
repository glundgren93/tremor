import type { Request, Response } from "playwright";
import {
  DEFAULT_REDACTION_CONFIG,
  redactBody,
  redactHeaders,
  redactResponseBody,
  redactUrl,
} from "../capture/redaction";
import type { RecordedExchange } from "./driver";

export async function recordResponse(
  res: Response,
  state: {
    recording: boolean;
    closed: boolean;
    pending: Map<Request, { start: number; id: string }>;
    nextId: () => number;
    exchanges: RecordedExchange[];
  },
): Promise<void> {
  if (!state.recording || state.closed) return;
  const req = res.request();
  const tracked = state.pending.get(req);
  state.pending.delete(req);
  let body = "";
  const contentType = res.headers()["content-type"] ?? "";
  if (!state.closed && /(json|xml|javascript\+json|text\/plain)/i.test(contentType)) {
    try {
      body = redactResponseBody((await res.body()).toString("utf8"), contentType) ?? "";
    } catch {
      body = "";
    }
  }
  let requestHeaders = req.headers();
  try {
    requestHeaders = await req.allHeaders();
  } catch {
    /* navigation may remove request */
  }
  state.exchanges.push({
    id: tracked?.id ?? `xchg-${state.nextId()}`,
    timestamp: tracked?.start ?? Date.now(),
    method: req.method(),
    url: redactUrl(req.url(), DEFAULT_REDACTION_CONFIG),
    resourceType: req.resourceType(),
    requestHeaders: redactHeaders(requestHeaders, DEFAULT_REDACTION_CONFIG),
    requestBody: redactBody(req.postData(), requestHeaders["content-type"] ?? "") ?? "",
    response: {
      status: res.status(),
      statusText: res.statusText(),
      headers: redactHeaders(res.headers(), DEFAULT_REDACTION_CONFIG),
      body,
      durationMs: tracked ? Date.now() - tracked.start : 0,
    },
  });
}
