import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Claude Accounts — worker.
 *
 * Three jobs:
 *  1. Spend per account. Paperclip records every run against the subscription it actually used
 *     (cost_events.subscription_id) and the run carries the price the same work would have cost
 *     through the paid API (usage_json.costUsd). Summing those gives an exact per-account figure.
 *  2. Real usage limits. Claude sends the session/weekly utilisation with its answers. The optional
 *     limits patch (scripts/limits-patch.mjs) makes Paperclip's Claude bridge append them to a local
 *     file; here they are matched to the account each run used.
 *  3. "Check limit" button. One short run of an agent you choose, pinned to the account for that
 *     run only, so Claude reports that account's limits.
 *  4. Auto-switch (off by default). A job every 5 minutes keeps standby accounts' limits fresh
 *     and moves the default to the least used account when the current one reaches the threshold.
 */

// Paperclip's own HTTP API, used for the few things the plugin SDK does not expose
// (AI connections, active runs, pinning an agent to an account). Works without credentials when
// Paperclip runs in its default local mode.
const API = (process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const DATA_DIR = process.env.CLAUDE_ACCOUNTS_DIR ?? path.join(os.homedir(), ".paperclip", "claude-accounts");
const LIMITS_LOG = path.join(DATA_DIR, "limits.jsonl");
const PIN_MARKER = path.join(DATA_DIR, "check-pin.json");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const COSTS_SQL = `
WITH ev AS (
  SELECT heartbeat_run_id, subscription_id,
         sum(input_tokens) AS i, sum(cached_input_tokens) AS c, sum(output_tokens) AS o,
         max(occurred_at) AS last_at
  FROM public.cost_events
  WHERE company_id = $1::uuid AND occurred_at >= $2::timestamptz
  GROUP BY heartbeat_run_id, subscription_id
)
SELECT ev.subscription_id AS subscription_id,
       count(*)::int AS runs,
       coalesce(sum(ev.i), 0)::float8 AS input_tokens,
       coalesce(sum(ev.c), 0)::float8 AS cached_tokens,
       coalesce(sum(ev.o), 0)::float8 AS output_tokens,
       coalesce(sum((hr.usage_json->>'costUsd')::numeric), 0)::float8 AS usd,
       max(ev.last_at) AS last_at
FROM ev
LEFT JOIN public.heartbeat_runs hr ON hr.id = ev.heartbeat_run_id
GROUP BY ev.subscription_id`;

type CostRow = {
  subscription_id: string | null;
  runs: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  usd: number;
  last_at: string | Date | null;
};

type LimitWindow = { id: string; usedPercent: number; resetsAt: string | null };
type AccountLimits = {
  status: "ok" | "denied" | "rate_limited" | "error";
  limits: LimitWindow[];
  /** When the numbers shown were obtained. */
  goodAt: string | null;
  /** "claude": Paperclip's own usage check answered. "runs": taken from agent runs via the limits patch. */
  source?: "claude" | "runs";
};

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function sendJson(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const listOf = (value: any): any[] => (Array.isArray(value) ? value : (value?.items ?? []));

// ── Source 1: Paperclip's own usage check ──────────────────────────────────────────────────────
// It only answers for credentials allowed to read usage, and Claude throttles it hard, so ask
// rarely and remember refusals for a while.
const OK_TTL = 10 * 60 * 1000;
const RATE_LIMITED_TTL = 30 * 60 * 1000;
const DENIED_TTL = 60 * 60 * 1000;
const usageCache = new Map<string, { nextAt: number; value: AccountLimits }>();

async function usageFromPaperclip(companyId: string, connectionId: string): Promise<AccountLimits> {
  const hit = usageCache.get(connectionId);
  if (hit && Date.now() < hit.nextAt) return hit.value;
  const now = new Date().toISOString();
  let value: AccountLimits;
  let ttl = OK_TTL;
  try {
    const u = await getJson(`${API}/api/companies/${companyId}/ai-connections/${connectionId}/usage`);
    const limits: LimitWindow[] = listOf(u?.limits)
      .filter((l: any) => typeof l?.usedPercent === "number")
      .map((l: any) => ({ id: String(l.id ?? ""), usedPercent: l.usedPercent, resetsAt: l.resetsAt ?? null }));
    if (u?.status === "ok" && limits.length) {
      value = { status: "ok", limits, goodAt: now, source: "claude" };
    } else {
      const status =
        u?.errorCode === "permission_denied" || u?.errorCode === "authentication_required"
          ? "denied"
          : u?.errorCode === "rate_limited"
            ? "rate_limited"
            : "error";
      ttl = status === "denied" ? DENIED_TTL : status === "rate_limited" ? RATE_LIMITED_TTL : OK_TTL;
      value = { status, limits: [], goodAt: null };
    }
  } catch {
    value = { status: "error", limits: [], goodAt: null };
  }
  usageCache.set(connectionId, { nextAt: Date.now() + ttl, value });
  return value;
}

// ── Source 2: limits reported to agent runs (needs the limits patch) ───────────────────────────
type LimitEvent = {
  at: string;
  runId: string | null;
  info?: { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }> };
};
const WINDOW_ORDER = ["five_hour", "seven_day"];

async function limitsLogExists(): Promise<boolean> {
  return stat(LIMITS_LOG).then(
    () => true,
    () => false,
  );
}

async function readLimitEvents(): Promise<LimitEvent[]> {
  let text: string;
  try {
    text = await readFile(LIMITS_LOG, "utf8");
  } catch {
    return [];
  }
  let lines = text.split("\n").filter(Boolean);
  // Only the recent tail matters; keep the file from growing without bound.
  if (lines.length > 4000) {
    lines = lines.slice(-1500);
    await writeFile(LIMITS_LOG, lines.join("\n") + "\n", "utf8").catch(() => undefined);
  }
  const out: LimitEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as LimitEvent;
      if (e?.runId && e?.info?.unifiedWindows && Date.now() - Date.parse(e.at) < WEEK_MS) out.push(e);
    } catch {
      /* a half-written line */
    }
  }
  return out;
}

async function limitsFromRuns(
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>,
  companyId: string,
  conns: { id: string; name: string }[],
): Promise<Record<string, { limits: LimitWindow[]; at: string }>> {
  const events = await readLimitEvents();
  if (!events.length) return {};
  const runToConn = new Map<string, string>();
  try {
    // Finished runs: run -> subscription (database) -> connection (matched by account name).
    const subs = await getJson(`${API}/api/companies/${companyId}/costs/subscriptions?from=${new Date().toISOString().slice(0, 10)}`);
    const connByName = new Map(conns.map((c) => [c.name, c.id]));
    const connBySub = new Map<string, string>();
    for (const a of subs?.accounts ?? []) if (connByName.has(a.name)) connBySub.set(a.id, connByName.get(a.name)!);
    const rows = await query<{ run_id: string; subscription_id: string }>(
      `SELECT heartbeat_run_id::text AS run_id, subscription_id::text AS subscription_id
       FROM public.cost_events
       WHERE company_id = $1::uuid AND occurred_at >= $2::timestamptz AND subscription_id IS NOT NULL AND heartbeat_run_id IS NOT NULL`,
      [companyId, new Date(Date.now() - WEEK_MS).toISOString()],
    );
    for (const r of rows) if (connBySub.has(r.subscription_id)) runToConn.set(r.run_id, connBySub.get(r.subscription_id)!);
  } catch {
    /* finished runs stay unmatched this time */
  }
  // Runs still in flight have no cost record yet; Paperclip knows their account directly.
  await Promise.all(
    conns.map(async (c) => {
      try {
        for (const r of listOf(await getJson(`${API}/api/companies/${companyId}/ai-connections/${c.id}/active-runs`))) {
          if (r?.id) runToConn.set(r.id, c.id);
        }
      } catch {
        /* ignore */
      }
    }),
  );
  const latest: Record<string, { windows: Record<string, { usedPercent: number; resetsAt: number }>; at: string }> = {};
  for (const e of events) {
    const conn = runToConn.get(e.runId!);
    if (!conn) continue;
    const slot = (latest[conn] ??= { windows: {}, at: e.at });
    for (const [key, w] of Object.entries(e.info!.unifiedWindows!)) {
      if (key.includes("overage") || typeof w?.utilization !== "number") continue;
      // a window Claude already refuses is full, whatever the reported fraction says
      const usedPercent = w.status === "rejected" ? 100 : w.utilization * 100;
      slot.windows[key] = { usedPercent, resetsAt: Number(w.resetsAt) || 0 };
    }
    slot.at = e.at;
  }
  const out: Record<string, { limits: LimitWindow[]; at: string }> = {};
  for (const [conn, slot] of Object.entries(latest)) {
    const limits = Object.entries(slot.windows)
      // a window whose reset time has passed no longer describes the account
      .filter(([, w]) => !w.resetsAt || w.resetsAt * 1000 > Date.now())
      .sort(([a], [b]) => (WINDOW_ORDER.indexOf(a) + 1 || 99) - (WINDOW_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b))
      .map(([id, w]) => ({ id, usedPercent: w.usedPercent, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }));
    if (limits.length) out[conn] = { limits, at: slot.at };
  }
  return out;
}

// ── "Check limit": one short run of the chosen agent on the chosen account ─────────────────────
type CheckCode =
  | "running"
  | "done"
  | "slow"
  | "run_failed"
  | "api_unreachable"
  | "no_probe"
  | "probe_busy"
  | "error"
  | "restore_failed";
type CheckState = { code: CheckCode; detail?: string; agent?: string; at: string };
const checks = new Map<string, CheckState>();

async function setBinding(agentId: string, binding: unknown): Promise<void> {
  const a = await getJson(`${API}/api/agents/${agentId}`);
  await sendJson("PATCH", `${API}/api/agents/${agentId}`, {
    runtimeSettings: {
      harness: a.adapterType,
      aiConnection: binding,
      expected: { model: a.adapterConfig?.model ?? null, aiConnection: a.runtimeConfig?.aiConnection ?? null },
    },
  });
}

// If the worker was restarted in the middle of a check, put the agent back on its own account.
async function restoreLeftoverPin(): Promise<void> {
  try {
    const m = JSON.parse(await readFile(PIN_MARKER, "utf8"));
    await setBinding(m.agentId, m.original);
    await rm(PIN_MARKER, { force: true });
  } catch {
    /* no marker, nothing to restore */
  }
}

async function runCheck(companyId: string, conn: { id: string; grantId: string; provider: string; method?: string }, probeAgentId: string): Promise<void> {
  const set = (code: CheckCode, extra: Partial<CheckState> = {}) => checks.set(conn.id, { code, at: new Date().toISOString(), ...extra });
  let probe: any;
  try {
    probe = await getJson(`${API}/api/agents/${probeAgentId}`);
  } catch {
    return void set("api_unreachable");
  }
  if (!probe?.id) return void set("no_probe");
  if (probe.status !== "idle") return void set("probe_busy", { agent: probe.name });
  const original = probe.runtimeConfig?.aiConnection ?? { provider: "anthropic", method: "subscription", mode: "responsible_user" };
  set("running", { agent: probe.name });
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(PIN_MARKER, JSON.stringify({ agentId: probe.id, original }), "utf8");
    await setBinding(probe.id, {
      provider: conn.provider,
      method: conn.method ?? "subscription",
      mode: "delegated",
      connectionId: conn.id,
      grantId: conn.grantId,
    });
    const run = await sendJson("POST", `${API}/api/agents/${probe.id}/heartbeat/invoke`, {});
    let status = "running";
    let error = "";
    for (let i = 0; i < 40 && (status === "running" || status === "queued"); i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const cur = listOf(await getJson(`${API}/api/companies/${companyId}/heartbeat-runs?limit=30`).catch(() => null)).find((r: any) => r.id === run?.id);
      if (cur) {
        status = cur.status;
        error = String(cur.error ?? "");
      }
    }
    if (status === "succeeded") set("done", { agent: probe.name });
    else if (status === "running" || status === "queued") set("slow", { agent: probe.name });
    else set("run_failed", { agent: probe.name, detail: error.split("\n")[0].slice(0, 200) || status });
  } catch (e) {
    set("error", { detail: e instanceof Error ? e.message : String(e) });
  } finally {
    await setBinding(probe.id, original)
      .then(() => rm(PIN_MARKER, { force: true }))
      .catch(() => set("restore_failed", { agent: probe.name }));
  }
}

// ── Auto-switch ────────────────────────────────────────────────────────────────────────────────
type Settings = { autoSwitch: boolean; threshold: number; standbyCheckMinutes: number; excluded: string[] };
const DEFAULT_SETTINGS: Settings = { autoSwitch: false, threshold: 90, standbyCheckMinutes: 60, excluded: [] };
type SwitchEvent = { at: string; kind: "switched" | "no_candidate" | "failed"; from: string; to: string | null; percent: number; window: string };
const SWITCH_COOLDOWN_MS = 30 * 60 * 1000;
/** Limits of the default account older than this are not trusted for a switch decision. */
const DEFAULT_FRESH_MS = 30 * 60 * 1000;
const standbyAttempts = new Map<string, number>();

function normalizeSettings(raw: unknown): Settings {
  const src = (raw ?? {}) as Record<string, unknown>;
  const threshold = Math.round(Number(src.threshold));
  const standby = Number(src.standbyCheckMinutes);
  return {
    autoSwitch: src.autoSwitch === true,
    threshold: Number.isFinite(threshold) ? Math.min(100, Math.max(50, threshold)) : DEFAULT_SETTINGS.threshold,
    standbyCheckMinutes: [0, 30, 60].includes(standby) ? standby : DEFAULT_SETTINGS.standbyCheckMinutes,
    excluded: Array.isArray(src.excluded) ? [...new Set(src.excluded.map(String).filter((id) => UUID.test(id)))].slice(0, 50) : [],
  };
}

/** The fullest window of an account; an account with no known window counts as free. */
function fullest(limits: LimitWindow[] | undefined): { percent: number; window: string } {
  let top = { percent: 0, window: "" };
  for (const l of limits ?? []) if (l.usedPercent > top.percent) top = { percent: l.usedPercent, window: l.id };
  return top;
}

function requireCompany(params: Record<string, unknown>): string {
  const companyId = String(params.companyId ?? "");
  if (!UUID.test(companyId)) throw new Error("companyId is required");
  return companyId;
}

const plugin = definePlugin({
  async setup(ctx) {
    void restoreLeftoverPin();
    // Everything is kept in instance-scoped state with the company id in the key: the scheduled job
    // runs outside any company and cannot read company-scoped state.
    const stateKey = (name: string, companyId: string) => ({ scopeKind: "instance" as const, stateKey: `${name}:${companyId}` });
    const probeKey = (companyId: string) => stateKey("probeAgentId", companyId);
    const settingsKey = (companyId: string) => stateKey("settings", companyId);
    const logKey = (companyId: string) => stateKey("switchLog", companyId);
    // The job runs outside any company, so remember which companies turned auto-switch on.
    const enabledKey = { scopeKind: "instance" as const, stateKey: "autoSwitchCompanies" };
    const readSettings = async (companyId: string) => normalizeSettings(await ctx.state.get(settingsKey(companyId)).catch(() => null));
    const readLog = async (companyId: string): Promise<SwitchEvent[]> => {
      const v = await ctx.state.get(logKey(companyId)).catch(() => null);
      return Array.isArray(v) ? (v as SwitchEvent[]) : [];
    };
    const addLog = async (companyId: string, event: SwitchEvent) => ctx.state.set(logKey(companyId), [...(await readLog(companyId)), event].slice(-20));

    /** Connections plus the best known limits for each of them. */
    const collectLimits = async (companyId: string) => {
      let conns: any[] = [];
      let apiReachable = true;
      try {
        const d = await getJson(`${API}/api/companies/${companyId}/ai-connections`);
        conns = (d?.connections ?? []).filter((c: any) => c.provider === "anthropic");
      } catch {
        apiReachable = false;
      }
      const seen = await limitsFromRuns((sql, p) => ctx.db.query(sql, p), companyId, conns).catch(
        () => ({}) as Record<string, { limits: LimitWindow[]; at: string }>,
      );
      const accounts: Record<string, AccountLimits> = {};
      for (const c of conns) {
        const fromClaude: AccountLimits =
          c.usageProbeSupported === false ? { status: "denied", limits: [], goodAt: null } : await usageFromPaperclip(companyId, c.id);
        const fromRuns = seen[c.id];
        accounts[c.id] =
          fromClaude.status === "ok" ? fromClaude : fromRuns ? { status: "ok", limits: fromRuns.limits, goodAt: fromRuns.at, source: "runs" } : fromClaude;
      }
      return { conns, accounts, apiReachable };
    };

    const tickKey = (companyId: string) => stateKey("lastAutoCheck", companyId);
    const autoSwitchTick = async (companyId: string) => {
      const settings = await readSettings(companyId);
      if (!settings.autoSwitch) return;
      const { conns, accounts } = await collectLimits(companyId);
      const current = conns.find((c: any) => c.isDefault);
      // Shown in the widget, so it is visible that the job is alive and what it saw.
      await ctx.state.set(tickKey(companyId), { at: new Date().toISOString(), percent: current ? Math.round(fullest(accounts[current.id]?.limits).percent) : null });
      if (!current) return;
      const standby = conns.filter((c: any) => !c.isDefault && c.status === "connected" && !settings.excluded.includes(c.id));

      // 1. Keep standby accounts' numbers fresh: at most one check per tick, oldest first.
      const checkRunning = [...checks.values()].some((c) => c.code === "running");
      const probeAgentId = (await ctx.state.get(probeKey(companyId)).catch(() => null)) as string | null;
      if (settings.standbyCheckMinutes > 0 && probeAgentId && !checkRunning) {
        const maxAge = settings.standbyCheckMinutes * 60 * 1000;
        const known = (c: any) => Math.max(Date.parse(accounts[c.id]?.goodAt ?? "") || 0, standbyAttempts.get(c.id) ?? 0);
        const stale = standby.filter((c: any) => Date.now() - known(c) > maxAge).sort((a: any, b: any) => known(a) - known(b))[0];
        if (stale) {
          standbyAttempts.set(stale.id, Date.now());
          checks.set(stale.id, { code: "running", at: new Date().toISOString() });
          void runCheck(companyId, stale, probeAgentId);
        }
      }

      // 2. Switch when the default account has reached the threshold.
      const goodAt = Date.parse(accounts[current.id]?.goodAt ?? "") || 0;
      const top = fullest(accounts[current.id]?.limits);
      if (Date.now() - goodAt > DEFAULT_FRESH_MS || top.percent < settings.threshold) return;
      const log = await readLog(companyId);
      const lastSwitch = [...log].reverse().find((e) => e.kind === "switched");
      if (lastSwitch && Date.now() - Date.parse(lastSwitch.at) < SWITCH_COOLDOWN_MS) return;
      const base = { at: new Date().toISOString(), from: current.name, percent: Math.round(top.percent), window: top.window };
      const candidate = standby
        .map((c: any) => ({ c, used: fullest(accounts[c.id]?.limits).percent }))
        .filter((x: any) => x.used < settings.threshold)
        .sort((a: any, b: any) => a.used - b.used)[0];
      if (!candidate) {
        // say it once per hour, not every five minutes
        const last = log[log.length - 1];
        if (!(last?.kind === "no_candidate" && Date.now() - Date.parse(last.at) < 60 * 60 * 1000)) await addLog(companyId, { ...base, kind: "no_candidate", to: null });
        return;
      }
      try {
        await sendJson("PUT", `${API}/api/companies/${companyId}/ai-connections/default`, { grantId: candidate.c.grantId });
        await addLog(companyId, { ...base, kind: "switched", to: candidate.c.name });
        ctx.logger.info("Auto-switched the default Claude account", { from: current.name, to: candidate.c.name, percent: base.percent, window: base.window });
      } catch {
        await addLog(companyId, { ...base, kind: "failed", to: candidate.c.name });
      }
    };

    ctx.jobs.register("auto-switch", async () => {
      const ids = await ctx.state.get(enabledKey).catch(() => null);
      for (const companyId of Array.isArray(ids) ? (ids as string[]) : []) {
        await autoSwitchTick(companyId).catch((e) => ctx.logger.warn("Auto-switch tick failed", { companyId, error: String(e) }));
      }
    });

    ctx.actions.register("save-settings", async (params) => {
      const companyId = requireCompany(params);
      const next = normalizeSettings(params);
      await ctx.state.set(settingsKey(companyId), next);
      const ids = await ctx.state.get(enabledKey).catch(() => null);
      const set = new Set(Array.isArray(ids) ? (ids as string[]) : []);
      if (next.autoSwitch) set.add(companyId);
      else set.delete(companyId);
      await ctx.state.set(enabledKey, [...set]);
      return { settings: next };
    });

    ctx.data.register("account-costs", async (params) => {
      const companyId = requireCompany(params);
      const since = String(params.since ?? "1970-01-01T00:00:00Z");
      if (Number.isNaN(Date.parse(since))) throw new Error("invalid 'since'");
      const rows = await ctx.db.query<CostRow>(COSTS_SQL, [companyId, new Date(since).toISOString()]);
      return {
        since,
        generatedAt: new Date().toISOString(),
        accounts: rows.map((r) => ({
          subscriptionId: r.subscription_id,
          runs: Number(r.runs) || 0,
          inputTokens: Number(r.input_tokens) || 0,
          cachedTokens: Number(r.cached_tokens) || 0,
          outputTokens: Number(r.output_tokens) || 0,
          usd: Number(r.usd) || 0,
          lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        })),
      };
    });

    ctx.data.register("account-limits", async (params) => {
      const companyId = requireCompany(params);
      const probeAgentId = ((await ctx.state.get(probeKey(companyId)).catch(() => null)) as string | null) ?? null;
      const { accounts, apiReachable } = await collectLimits(companyId);
      return {
        accounts,
        checks: Object.fromEntries(checks),
        probeAgentId,
        /** false until the limits patch has written at least once */
        limitsLogSeen: await limitsLogExists(),
        apiReachable,
        settings: await readSettings(companyId),
        switchLog: (await readLog(companyId)).slice(-3),
        lastAutoCheck: await ctx.state.get(tickKey(companyId)).catch(() => null),
      };
    });

    ctx.actions.register("set-probe-agent", async (params) => {
      const companyId = requireCompany(params);
      const agentId = params.agentId == null || params.agentId === "" ? null : String(params.agentId);
      if (agentId && !UUID.test(agentId)) throw new Error("invalid agentId");
      await ctx.state.set(probeKey(companyId), agentId);
      return { probeAgentId: agentId };
    });

    ctx.actions.register("check-limits", async (params) => {
      const companyId = requireCompany(params);
      const connectionId = String(params.connectionId ?? "");
      if (!UUID.test(connectionId)) throw new Error("connectionId is required");
      if ([...checks.values()].some((c) => c.code === "running")) throw new Error("ALREADY_RUNNING");
      const probeAgentId = (await ctx.state.get(probeKey(companyId)).catch(() => null)) as string | null;
      if (!probeAgentId) throw new Error("NO_PROBE_AGENT");
      const d = await getJson(`${API}/api/companies/${companyId}/ai-connections`).catch(() => {
        throw new Error("API_UNREACHABLE");
      });
      const conn = (d?.connections ?? []).find((c: any) => c.id === connectionId && c.provider === "anthropic");
      if (!conn) throw new Error("ACCOUNT_NOT_FOUND");
      checks.set(conn.id, { code: "running", at: new Date().toISOString() });
      void runCheck(companyId, conn, probeAgentId);
      return { started: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Claude Accounts widget is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
