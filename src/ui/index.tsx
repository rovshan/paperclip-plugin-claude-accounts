import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { usePluginAction, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { detectLang, STRINGS, type Strings } from "./i18n.js";

type Connection = { id: string; grantId: string; name: string; provider: string; isDefault?: boolean; status?: string };
type ActiveRun = { agentName?: string; status?: string };
type Agent = { id: string; name: string; status: string; adapterType: string };
type CostAccount = { subscriptionId: string | null; runs: number; inputTokens: number; cachedTokens: number; outputTokens: number; usd: number };
type CostData = { accounts: CostAccount[]; generatedAt: string };
type LimitWindow = { id: string; usedPercent: number; resetsAt: string | null };
type AccountLimits = { status: "ok" | "denied" | "rate_limited" | "error"; limits: LimitWindow[]; goodAt: string | null; source?: "claude" | "runs" };
type CheckCode = "running" | "done" | "slow" | "run_failed" | "api_unreachable" | "no_probe" | "probe_busy" | "error" | "restore_failed";
type CheckState = { code: CheckCode; detail?: string; agent?: string; at: string };
type LimitsData = {
  accounts: Record<string, AccountLimits>;
  checks?: Record<string, CheckState>;
  probeAgentId: string | null;
  limitsLogSeen: boolean;
  apiReachable: boolean;
};
type PeriodKey = "today" | "week" | "month" | "all";

const PERIOD_KEYS: PeriodKey[] = ["today", "week", "month", "all"];
const GREEN = "#1f9d55";
const AMBER = "#c27a0a";
const BLUE = "#2f6fde";
const PIN_KEY = "paperclip-plugin-claude-accounts:pinTop";
const muted: CSSProperties = { color: "var(--muted-foreground)" };

function periodStart(key: PeriodKey): string {
  const d = new Date();
  if (key === "all") return "1970-01-01T00:00:00.000Z";
  d.setHours(0, 0, 0, 0);
  if (key === "week") d.setDate(d.getDate() - 6);
  if (key === "month") d.setDate(1);
  return d.toISOString();
}

const usd = (v: number) => "$" + (v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch("/api" + path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** "14:05" today, otherwise "Thu 14:05" (weekday) or "12 Nov 14:05" (date). */
function when(iso: string, t: Strings, style: "weekday" | "date"): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(t.locale, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  const day = style === "weekday" ? d.toLocaleDateString(t.locale, { weekday: "short" }) : d.toLocaleDateString(t.locale, { day: "numeric", month: "short" });
  return `${day} ${time}`;
}

function checkMessage(c: CheckState, t: Strings): string {
  switch (c.code) {
    case "done":
      return t.check.done;
    case "slow":
      return t.check.slow;
    case "run_failed":
      return t.check.run_failed(c.detail);
    case "api_unreachable":
      return t.check.api_unreachable;
    case "no_probe":
      return t.check.no_probe;
    case "probe_busy":
      return t.check.probe_busy(c.agent);
    case "restore_failed":
      return t.check.restore_failed(c.agent);
    default:
      return t.check.error(c.detail);
  }
}

function LimitBars({ data, t, patchSeen }: { data: AccountLimits | undefined; t: Strings; patchSeen: boolean }) {
  if (!data) return <div style={{ ...muted, fontSize: 12 }}>{t.limitsLoading}</div>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {data.limits.map((l) => {
        const p = Math.max(0, Math.min(100, Math.round(l.usedPercent)));
        const color = p >= 90 ? "var(--destructive)" : p >= 70 ? AMBER : BLUE;
        const name = t.limitName(l.id);
        return (
          <div key={l.id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
              <span>{name}</span>
              <span style={muted}>
                {t.used(p)}
                {l.resetsAt ? t.resets(when(l.resetsAt, t, "weekday")) : ""}
              </span>
            </div>
            <div role="img" aria-label={`${name}: ${t.used(p)}`} style={{ height: 5, borderRadius: 3, background: "var(--muted)", marginTop: 3, overflow: "hidden" }}>
              <div style={{ width: p + "%", height: "100%", background: color }} />
            </div>
          </div>
        );
      })}
      {data.limits.length > 0 && data.goodAt && (
        <div style={{ ...muted, fontSize: 12 }}>{data.source === "runs" ? t.fromRuns(when(data.goodAt, t, "date")) : t.fromClaude(when(data.goodAt, t, "date"))}</div>
      )}
      {data.limits.length === 0 && <div style={{ ...muted, fontSize: 12 }}>{patchSeen ? t.noLimitData : t.noLimitDataNoPatch}</div>}
    </div>
  );
}

export function ClaudeAccountsWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const t = useMemo(() => STRINGS[detectLang()], []);
  const root = useRef<HTMLDivElement>(null);
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [subNames, setSubNames] = useState<Record<string, string>>({});
  const [active, setActive] = useState<Record<string, string[]>>({});
  const [loadError, setLoadError] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [dayKey, setDayKey] = useState(() => new Date().toDateString());
  const [pinTop, setPinTop] = useState(() => {
    try {
      return window.localStorage.getItem(PIN_KEY) !== "0";
    } catch {
      return true;
    }
  });

  const costParams = useMemo(
    () => ({ companyId: companyId ?? "", since: periodStart(period) }),
    // dayKey keeps "today" honest when the page stays open past midnight
    [companyId, period, dayKey],
  );
  const costs = usePluginData<CostData>("account-costs", costParams);
  const limitParams = useMemo(() => ({ companyId: companyId ?? "" }), [companyId]);
  const limits = usePluginData<LimitsData>("account-limits", limitParams);
  const checkLimits = usePluginAction("check-limits");
  const setProbeAgent = usePluginAction("set-probe-agent");

  // Several accounts side by side need the whole dashboard row. Optionally the block is also
  // moved above Paperclip's own panels; the host has no setting for widget order, so this is done
  // with CSS on the surrounding containers and can be switched off below the accounts.
  useEffect(() => {
    const cell = root.current?.parentElement;
    if (!cell) return;
    cell.style.gridColumn = "1 / -1";
    const slot = cell.parentElement;
    const page = slot?.parentElement;
    if (pinTop) {
      cell.style.order = "-2";
      if (slot && page) {
        page.style.display = "flex";
        page.style.flexDirection = "column";
        slot.style.order = "-1";
      }
    } else {
      cell.style.order = "";
    }
  }, [pinTop]);

  const loadConnections = useCallback(async () => {
    if (!companyId) return;
    try {
      const d = await api<{ connections: Connection[] }>(`/companies/${companyId}/ai-connections`);
      const list = (d?.connections ?? []).filter((c) => c.provider === "anthropic");
      setConns(list);
      setLoadError(false);
      const runs = await Promise.all(
        list.map((c) =>
          api<ActiveRun[] | { items: ActiveRun[] }>(`/companies/${companyId}/ai-connections/${c.id}/active-runs`)
            .then((r) => (Array.isArray(r) ? r : (r?.items ?? [])))
            .catch(() => [] as ActiveRun[]),
        ),
      );
      const next: Record<string, string[]> = {};
      list.forEach((c, i) => {
        next[c.id] = runs[i].filter((r) => r.status === "running").map((r) => r.agentName ?? t.agentFallback);
      });
      setActive(next);
    } catch {
      setLoadError(true);
    }
  }, [companyId, t]);

  const loadStatic = useCallback(async () => {
    if (!companyId) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const d = await api<{ accounts: { id: string; name: string }[] }>(`/companies/${companyId}/costs/subscriptions?from=${today}`);
      const map: Record<string, string> = {};
      for (const a of d?.accounts ?? []) map[a.id] = a.name;
      setSubNames(map);
    } catch {
      /* names are only needed to match spend to accounts; keep the previous map */
    }
    try {
      const list = await api<Agent[] | { items: Agent[] }>(`/companies/${companyId}/agents`);
      const all = Array.isArray(list) ? list : (list?.items ?? []);
      setAgents(all.filter((a) => a.adapterType === "claude_local" && a.status !== "terminated").sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      /* the check-agent picker stays empty */
    }
  }, [companyId]);

  // The hooks may hand back new refresh functions on every render; keep the timers independent of them.
  const refreshCosts = useRef(costs.refresh);
  refreshCosts.current = costs.refresh;
  const refreshLimits = useRef(limits.refresh);
  refreshLimits.current = limits.refresh;

  useEffect(() => {
    void loadConnections();
    void loadStatic();
    const timer = setInterval(() => {
      setDayKey(new Date().toDateString());
      void loadConnections();
      refreshCosts.current();
      refreshLimits.current();
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadConnections, loadStatic]);

  const checks = limits.data?.checks ?? {};
  const checking = starting || Object.values(checks).some((c) => c.code === "running");
  // While a check is running, look for its result every few seconds.
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => refreshLimits.current(), 5000);
    return () => clearInterval(timer);
  }, [checking]);

  const startCheck = async (c: Connection) => {
    setNotice(null);
    setStarting(true);
    try {
      await checkLimits({ companyId, connectionId: c.id });
      limits.refresh();
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      const known = Object.keys(t.startErrors).find((k) => k !== "fallback" && code.includes(k)) as keyof Strings["startErrors"] | undefined;
      setNotice(known ? t.startErrors[known] : t.startErrors.fallback);
    } finally {
      setStarting(false);
    }
  };

  const chooseProbe = async (agentId: string) => {
    setNotice(null);
    try {
      await setProbeAgent({ companyId, agentId });
      limits.refresh();
    } catch {
      setNotice(t.startErrors.fallback);
    }
  };

  const makeDefault = async (c: Connection) => {
    if (!companyId || switching) return;
    setSwitching(c.id);
    setNotice(null);
    try {
      await api(`/companies/${companyId}/ai-connections/default`, { method: "PUT", body: JSON.stringify({ grantId: c.grantId }) });
      await loadConnections();
    } catch {
      setNotice(t.switchError(c.name));
    } finally {
      setSwitching(null);
    }
  };

  const togglePin = () => {
    const next = !pinTop;
    setPinTop(next);
    try {
      window.localStorage.setItem(PIN_KEY, next ? "1" : "0");
    } catch {
      /* the choice just will not be remembered */
    }
  };

  const spendByName = useMemo(() => {
    const out: Record<string, CostAccount> = {};
    let unmatched = 0;
    for (const a of costs.data?.accounts ?? []) {
      const name = a.subscriptionId ? subNames[a.subscriptionId] : undefined;
      if (name) out[name] = a;
      else unmatched += a.usd;
    }
    return { out, unmatched };
  }, [costs.data, subNames]);

  const total = (costs.data?.accounts ?? []).reduce((s, a) => s + a.usd, 0);
  const current = conns?.find((c) => c.isDefault);
  const probeAgentId = limits.data?.probeAgentId ?? "";
  const linkButton: CSSProperties = { font: "inherit", fontSize: 12, padding: 0, border: 0, background: "none", color: "var(--muted-foreground)", textDecoration: "underline", cursor: "pointer" };

  if (!companyId) return <div ref={root} style={muted}>{t.selectCompany}</div>;

  return (
    <div ref={root} style={{ display: "grid", gap: 14, fontSize: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{t.title}</div>
          <div style={{ ...muted, fontSize: 13 }}>{current ? t.defaultIs(current.name) : t.noDefault}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div role="group" aria-label={t.periodLabel} style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            {PERIOD_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={period === key}
                onClick={() => setPeriod(key)}
                style={{
                  padding: "5px 10px",
                  fontSize: 13,
                  border: 0,
                  cursor: "pointer",
                  background: period === key ? "var(--foreground)" : "transparent",
                  color: period === key ? "var(--background)" : "var(--muted-foreground)",
                }}
              >
                {t.periods[key]}
              </button>
            ))}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontWeight: 600, fontSize: 20, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{costs.data ? usd(total) : "…"}</div>
            <div style={{ ...muted, fontSize: 12 }}>{t.totalCaption}</div>
          </div>
        </div>
      </div>

      {loadError && <div style={{ color: "var(--destructive)", fontSize: 13 }}>{t.loadError}</div>}
      {costs.error && <div style={{ color: "var(--destructive)", fontSize: 13 }}>{t.costError(costs.error.message)}</div>}
      {notice && (
        <div role="alert" style={{ color: "var(--destructive)", fontSize: 13 }}>
          {notice}
        </div>
      )}

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
        {conns === null && !loadError && <div style={muted}>{t.loadingAccounts}</div>}
        {conns !== null && conns.length === 0 && <div style={muted}>{t.noAccounts}</div>}
        {(conns ?? []).map((c) => {
          const spend = spendByName.out[c.name];
          const share = total > 0 && spend ? Math.round((spend.usd / total) * 100) : 0;
          const busy = active[c.id] ?? [];
          const check = checks[c.id];
          return (
            <section
              key={c.id}
              style={{ border: "1px solid " + (c.isDefault ? GREEN : "var(--border)"), borderRadius: 8, padding: 12, display: "grid", gap: 10, alignContent: "start" }}
            >
              <div>
                <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{c.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 13, marginTop: 2 }}>
                  <span style={{ color: c.isDefault ? GREEN : "var(--muted-foreground)", fontWeight: c.isDefault ? 600 : 400 }}>{c.isDefault ? t.isDefault : t.standby}</span>
                  {c.status && c.status !== "connected" && <span style={{ color: "var(--destructive)" }}>{t.notConnected}</span>}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>{costs.data ? usd(spend?.usd ?? 0) : "…"}</div>
                <div style={{ ...muted, fontSize: 12 }}>
                  {spend ? `${t.runs(spend.runs)} · ${t.tokens(spend.inputTokens + spend.cachedTokens + spend.outputTokens)}` : t.noRuns}
                </div>
                {spend && total > 0 && <div style={{ ...muted, fontSize: 12 }}>{t.share(share)}</div>}
              </div>

              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{t.limitsTitle}</div>
                <LimitBars data={limits.data?.accounts?.[c.id]} t={t} patchSeen={limits.data?.limitsLogSeen ?? true} />
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => void startCheck(c)}
                    style={{
                      padding: "4px 10px",
                      fontSize: 12,
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--foreground)",
                      cursor: checking ? "default" : "pointer",
                      opacity: checking && check?.code !== "running" ? 0.6 : 1,
                    }}
                  >
                    {check?.code === "running" ? t.checking : t.checkButton}
                  </button>
                  {check?.code === "running" && <span style={{ ...muted, fontSize: 12 }}>{t.checkRunning(check.agent)}</span>}
                  {check && check.code !== "running" && (
                    <span role="status" style={{ fontSize: 12, color: check.code === "done" ? GREEN : "var(--destructive)" }}>
                      {checkMessage(check, t)}
                    </span>
                  )}
                </div>
              </div>

              <div style={{ fontSize: 13, minHeight: 20 }}>
                {busy.length ? (
                  <span>
                    <span style={muted}>{t.workingNow}</span>
                    {busy.join(", ")}
                  </span>
                ) : (
                  <span style={muted}>{t.nobodyWorking}</span>
                )}
              </div>

              <button
                type="button"
                disabled={c.isDefault || switching !== null}
                onClick={() => void makeDefault(c)}
                style={{
                  justifySelf: "start",
                  padding: "6px 12px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: c.isDefault ? "transparent" : "var(--foreground)",
                  color: c.isDefault ? "var(--muted-foreground)" : "var(--background)",
                  cursor: c.isDefault || switching !== null ? "default" : "pointer",
                  opacity: switching !== null && switching !== c.id ? 0.6 : 1,
                }}
              >
                {c.isDefault ? t.alreadyDefault : switching === c.id ? t.switching : t.makeDefault}
              </button>
            </section>
          );
        })}
      </div>

      <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
        <label style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span>{t.probeLabel}</span>
          <select
            value={probeAgentId}
            onChange={(e) => void chooseProbe(e.target.value)}
            style={{ font: "inherit", fontSize: 13, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--background)", color: "var(--foreground)" }}
          >
            <option value="">{t.probeNone}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ ...muted, fontSize: 12 }}>{t.probeHint}</div>
      </div>

      <div style={{ ...muted, fontSize: 12 }}>
        {t.footer}
        {spendByName.unmatched > 0.005 && t.unmatched(usd(spendByName.unmatched))}{" "}
        <button type="button" style={linkButton} onClick={togglePin}>
          {pinTop ? t.pinTopOff : t.pinTop}
        </button>
      </div>
    </div>
  );
}
