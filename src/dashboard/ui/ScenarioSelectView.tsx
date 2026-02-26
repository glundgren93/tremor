import { useCallback, useMemo, useRef, useState } from "react";
import type { ScenarioItem } from "./types";

const PRESETS = [
  { id: "backend-down", label: "Backend Down", desc: "All API calls return 503" },
  { id: "slow-network", label: "Slow Network", desc: "~1.5s latency on all requests" },
  { id: "flaky", label: "Flaky", desc: "20% of API requests fail randomly" },
  { id: "timeout-chaos", label: "Timeout Chaos", desc: "30% of API requests hang" },
  { id: "empty-response", label: "Empty Response", desc: "200 OK with empty JSON body" },
  { id: "auth-cascade", label: "Auth Cascade", desc: "60% of API requests return 401" },
];

const CPU_PROFILES = [
  { id: "mid-tier-mobile", label: "Mid-tier Mobile", desc: "2x CPU slowdown", rate: 2 },
  { id: "low-end-mobile", label: "Low-end Mobile", desc: "4x CPU slowdown", rate: 4 },
  { id: "very-slow-device", label: "Very Slow Device", desc: "6x CPU slowdown", rate: 6 },
];

type Category = "error" | "timing" | "empty" | "corruption";
const ALL_CATEGORIES: Category[] = ["error", "timing", "empty", "corruption"];
const CATEGORY_LABELS: Record<Category, string> = { error: "Error", timing: "Timing", empty: "Empty", corruption: "Corruption" };
const CATEGORY_COLORS: Record<Category, string> = {
  error: "bg-critical/15 text-critical",
  timing: "bg-major/15 text-major",
  empty: "bg-minor/15 text-minor",
  corruption: "bg-accent/15 text-accent",
};
const METHOD_COLORS: Record<string, string> = {
  get: "bg-good/15 text-good",
  post: "bg-[rgba(59,130,246,0.15)] text-[#3b82f6]",
  put: "bg-major/15 text-major",
  patch: "bg-minor/15 text-minor",
  delete: "bg-critical/15 text-critical",
  head: "bg-accent/15 text-accent",
  options: "bg-accent/15 text-accent",
};

type EndpointInfo = { method: string; path: string; key: string };

function parseEndpoint(str: string): EndpointInfo {
  const match = str.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
  if (!match) return { method: "GET", path: str, key: str };
  const method = match[1]!.toUpperCase();
  let path = match[2]!;
  try {
    const u = new URL(path);
    path = u.pathname + u.search;
  } catch { /* keep as-is */ }
  return { method, path, key: `${method} ${path}` };
}

function groupByEndpoint(scenarios: ScenarioItem[]) {
  const map = new Map<string, { info: EndpointInfo; scenarios: ScenarioItem[] }>();
  for (const s of scenarios) {
    const info = parseEndpoint(s.endpoint || s.name);
    if (!map.has(info.key)) map.set(info.key, { info, scenarios: [] });
    map.get(info.key)!.scenarios.push(s);
  }
  return map;
}

function getRecommendedIds(scenarios: ScenarioItem[]): Set<string> {
  const groups = groupByEndpoint(scenarios);
  const candidates: ScenarioItem[] = [];
  for (const [, { scenarios: epScenarios }] of groups) {
    const bestByCategory: Record<string, ScenarioItem> = {};
    for (const s of epScenarios) {
      if (s.category === "corruption") continue;
      const existing = bestByCategory[s.category];
      if (!existing || (s.priority || 0) > (existing.priority || 0)) {
        bestByCategory[s.category] = s;
      }
    }
    candidates.push(...Object.values(bestByCategory));
  }
  candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return new Set(candidates.slice(0, 25).map((s) => s.id));
}

function stripEndpointPrefix(name: string, info: EndpointInfo): string {
  const arrowIdx = name.indexOf("\u2192");
  if (arrowIdx !== -1) return name.slice(arrowIdx + 1).trim();
  const dashIdx = name.indexOf(" - ");
  if (dashIdx !== -1) return name.slice(dashIdx + 3).trim();
  const methodPrefix = `${info.method} ${info.path}`;
  if (name.startsWith(methodPrefix)) return name.slice(methodPrefix.length).trim();
  return name;
}

export function ScenarioSelectView({
  scenarios,
  onRunSelected,
  onCancel,
  onSaveProfile,
  profileSaved,
}: {
  scenarios: ScenarioItem[];
  onRunSelected: (ids: string[], presets: string[], exploratory: boolean, cpuProfile: string | null) => void;
  onCancel: () => void;
  onSaveProfile: () => void;
  profileSaved: boolean;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedPresets, setSelectedPresets] = useState<Set<string>>(new Set());
  const [activeCategories, setActiveCategories] = useState<Set<Category>>(new Set(ALL_CATEGORIES));
  const [expandedEndpoints, setExpandedEndpoints] = useState<Set<string>>(new Set());
  const [endpointFilter, setEndpointFilter] = useState("");
  const [exploratory, setExploratory] = useState(false);
  const [selectedCpuProfile, setSelectedCpuProfile] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Refs for indeterminate checkbox state
  const headerCheckboxRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const groups = useMemo(() => groupByEndpoint(scenarios), [scenarios]);

  const filteredGroups = useMemo(() => {
    let source = groups;
    if (endpointFilter.trim()) {
      const lower = endpointFilter.toLowerCase();
      const filtered = new Map<string, { info: EndpointInfo; scenarios: ScenarioItem[] }>();
      for (const [key, value] of groups) {
        if (value.info.path.toLowerCase().includes(lower) || value.info.method.toLowerCase().includes(lower)) {
          filtered.set(key, value);
        }
      }
      source = filtered;
    }
    return source;
  }, [groups, endpointFilter]);

  const categoryCounts = useMemo(() => {
    const counts: Record<Category, number> = { error: 0, timing: 0, empty: 0, corruption: 0 };
    for (const s of scenarios) {
      if (s.category in counts) counts[s.category as Category]++;
    }
    return counts;
  }, [scenarios]);

  const totalSelected = selectedIds.size + selectedPresets.size;
  const canRun = totalSelected > 0 || exploratory;

  const togglePreset = (id: string) => {
    setSelectedPresets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleScenario = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCategory = (cat: Category) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      const isActive = next.has(cat);
      if (isActive) next.delete(cat);
      else next.add(cat);

      // Update selections: toggle all scenarios of this category
      setSelectedIds((prevIds) => {
        const ids = new Set(prevIds);
        for (const s of scenarios) {
          if (s.category === cat) {
            if (isActive) ids.delete(s.id);
            else ids.add(s.id);
          }
        }
        return ids;
      });
      return next;
    });
  };

  const selectAll = () => {
    setActiveCategories(new Set(ALL_CATEGORIES));
    setSelectedIds(new Set(scenarios.map((s) => s.id)));
    setSelectedPresets(new Set(PRESETS.map((p) => p.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
    setSelectedPresets(new Set());
  };

  const toggleEndpoint = (key: string, checked: boolean) => {
    const group = groups.get(key);
    if (!group) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const s of group.scenarios) {
        if (checked && !activeCategories.has(s.category as Category)) continue;
        if (checked) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });
  };

  const toggleExpand = (key: string) => {
    setExpandedEndpoints((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Update indeterminate state for header checkboxes
  const setHeaderRef = useCallback(
    (key: string, el: HTMLInputElement | null) => {
      if (el) headerCheckboxRefs.current.set(key, el);
      else headerCheckboxRefs.current.delete(key);
    },
    [],
  );

  // Compute header checkbox states
  const getEndpointCheckState = (key: string) => {
    const group = groups.get(key);
    if (!group) return { checked: false, indeterminate: false, countStr: "0/0" };
    const total = group.scenarios.length;
    const checked = group.scenarios.filter((s) => selectedIds.has(s.id)).length;
    return {
      checked: checked > 0,
      indeterminate: checked > 0 && checked < total,
      countStr: `${checked}/${total}`,
    };
  };

  const renderPresetCard = (p: (typeof PRESETS)[number]) => (
    <button
      key={p.id}
      className={`cursor-pointer rounded-lg border p-3 text-left transition-colors ${
        selectedPresets.has(p.id)
          ? "border-accent bg-accent-glow"
          : "border-border bg-bg hover:border-accent"
      }`}
      onClick={() => togglePreset(p.id)}
    >
      <div className="text-[13px] font-semibold text-text">{p.label}</div>
      <div className="mt-1 text-[11px] leading-tight text-dim">{p.desc}</div>
    </button>
  );

  return (
    <div className="min-h-[calc(100vh-65px)] p-6">
      {/* Header — title + count + Cancel + Run */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Select Test Scenarios</h2>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-dim">{totalSelected} selected</span>
          <button className="cursor-pointer rounded-lg border border-border bg-critical px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-85" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="cursor-pointer rounded-lg border-none bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canRun}
            onClick={() => onRunSelected([...selectedIds], [...selectedPresets], exploratory, selectedCpuProfile)}
          >
            {exploratory && totalSelected === 0 ? "Run Exploratory" : `Run Selected (${totalSelected})`}
          </button>
        </div>
      </div>

      {/* Presets */}
      <div className="mb-5 rounded-lg border border-border bg-surface p-4">
        <h3 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wider text-dim">
          Presets
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map(renderPresetCard)}
        </div>
      </div>

      {/* Device Simulation */}
      <div className="mb-5 rounded-lg border border-border bg-surface p-4">
        <h3 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wider text-dim">
          Device Simulation
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {CPU_PROFILES.map((p) => (
            <button
              key={p.id}
              className={`cursor-pointer rounded-lg border p-3 text-left transition-colors ${
                selectedCpuProfile === p.id
                  ? "border-accent bg-accent-glow"
                  : "border-border bg-bg hover:border-accent"
              }`}
              onClick={() => setSelectedCpuProfile((prev) => (prev === p.id ? null : p.id))}
            >
              <div className="text-[13px] font-semibold text-text">{p.label}</div>
              <div className="mt-1 text-[11px] leading-tight text-dim">{p.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Exploratory mode toggle */}
      <div className="mb-5 flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <button
          className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full border-none transition-colors duration-200 ${
            exploratory ? "bg-accent" : "bg-border"
          }`}
          onClick={() => setExploratory((v) => !v)}
          role="switch"
          aria-checked={exploratory}
        >
          <span
            className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform duration-200 ${
              exploratory ? "translate-x-5" : ""
            }`}
          />
        </button>
        <div>
          <span className="text-[13px] font-semibold text-text">Exploratory Mode</span>
          <p className="mt-0.5 text-[12px] leading-tight text-dim">
            Agent uses the app like a real user under fault conditions — clicks, types, submits forms, and discovers resilience issues through interaction. Can run solo or after curated scenarios.
          </p>
        </div>
      </div>

      {/* Advanced disclosure — "Customize scenarios" */}
      <div className="mb-4">
        <button
          className="flex cursor-pointer items-center gap-2 border-none bg-transparent text-[13px] font-semibold text-text transition-colors hover:text-accent"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <span
            className={`text-xs text-dim transition-transform duration-200 ${showAdvanced ? "rotate-90" : ""}`}
          >
            &#9654;
          </span>
          Customize scenarios ({scenarios.length} total)
        </button>
      </div>

      {/* Advanced panel — category filters, endpoint filter, endpoint cards */}
      <div className={`advanced-panel ${showAdvanced ? "expanded" : ""}`}>
        {/* Action buttons */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            className={`cursor-pointer rounded-lg border px-4 py-1.5 text-xs font-semibold transition-colors ${
              profileSaved
                ? "border-good bg-good/10 text-good"
                : "border-border bg-transparent text-text hover:border-accent"
            }`}
            onClick={onSaveProfile}
            disabled={profileSaved}
          >
            {profileSaved ? "Profile Saved" : "Save Profile"}
          </button>
          <button className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-1.5 text-xs font-semibold text-text transition-colors hover:border-accent" onClick={selectAll}>
            Select All
          </button>
          <button className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-1.5 text-xs font-semibold text-text transition-colors hover:border-accent" onClick={deselectAll}>
            Deselect All
          </button>
        </div>

        {/* Category filters */}
        <div className="mb-4 flex flex-wrap gap-2">
          {ALL_CATEGORIES.map((cat) => {
            if (categoryCounts[cat] === 0) return null;
            const isActive = activeCategories.has(cat);
            return (
              <button
                key={cat}
                className={`flex cursor-pointer select-none items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium text-text transition-all ${
                  isActive
                    ? "border-accent bg-accent-glow"
                    : "border-border bg-bg opacity-50 hover:border-accent"
                }`}
                onClick={() => toggleCategory(cat)}
              >
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${CATEGORY_COLORS[cat]}`}>
                  {CATEGORY_LABELS[cat]}
                </span>
                <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[11px] text-dim">
                  {categoryCounts[cat]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Endpoint filter */}
        <div className="mb-4">
          <input
            type="text"
            placeholder="Filter endpoints (e.g. /api/checkout)"
            value={endpointFilter}
            onChange={(e) => setEndpointFilter(e.target.value)}
            className="w-full max-w-[400px] rounded-lg border border-border bg-surface px-4 py-2 text-[13px] text-text outline-none placeholder:text-dim/40 transition-all focus:border-accent"
          />
        </div>

        {/* Endpoint cards */}
        <div>
          {[...filteredGroups.entries()].map(([key, { info, scenarios: epScenarios }]) => {
            const expanded = expandedEndpoints.has(key);
            const { checked, indeterminate, countStr } = getEndpointCheckState(key);
            return (
              <div
                key={key}
                className="mb-2 overflow-hidden rounded-lg border border-border bg-surface"
              >
                {/* Header */}
                <div
                  className="flex cursor-pointer select-none items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-white/[0.02]"
                  onClick={() => toggleExpand(key)}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 cursor-pointer accent-accent"
                    ref={(el) => {
                      setHeaderRef(key, el);
                      if (el) el.indeterminate = indeterminate;
                    }}
                    checked={checked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => toggleEndpoint(key, e.target.checked)}
                  />
                  <span
                    className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${METHOD_COLORS[info.method.toLowerCase()] ?? ""}`}
                  >
                    {info.method}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[13px] text-text"
                    title={key}
                  >
                    {info.path}
                  </span>
                  <span className="shrink-0 text-xs text-dim">{countStr}</span>
                  <span
                    className={`shrink-0 text-xs text-dim transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
                  >
                    &#9654;
                  </span>
                </div>

                {/* Body */}
                <div className={`endpoint-body ${expanded ? "expanded" : ""}`}>
                  <div className="flex flex-col gap-1 px-3.5 py-1 pl-[42px] pb-2.5">
                    {epScenarios.map((s) => {
                      const isSelected = selectedIds.has(s.id);
                      const displayName = stripEndpointPrefix(s.name, info);
                      return (
                        <label
                          key={s.id}
                          className={`flex cursor-pointer select-none items-center gap-2.5 rounded-md border px-2.5 py-1.5 transition-colors ${
                            isSelected
                              ? "border-accent bg-accent/[0.06]"
                              : "border-transparent hover:border-border hover:bg-white/[0.02]"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="size-4 shrink-0 accent-accent"
                            checked={isSelected}
                            onChange={() => toggleScenario(s.id)}
                          />
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${CATEGORY_COLORS[s.category]}`}
                          >
                            {s.category}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate text-[13px] font-medium"
                            title={s.name}
                          >
                            {displayName}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
