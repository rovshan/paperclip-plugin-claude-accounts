// All interface text lives here.
const MODEL_NAMES: Record<string, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", mythos: "Mythos" };

const en = {
  // 24-hour clock, English weekday and month names
  locale: "en-GB",
  title: "Claude accounts",
  selectCompany: "Select a company.",
  defaultIs: (name: string) => `New agent runs go through “${name}”`,
  noDefault: "No default account is selected",
  periodLabel: "Spend period",
  periods: { today: "Today", week: "7 days", month: "Month", all: "All time" },
  totalCaption: "total at API prices",
  loadingAccounts: "Loading accounts…",
  loadError: "Could not load the account list. Will retry in a minute.",
  costError: (m: string) => `Could not calculate spend: ${m}`,
  noAccounts: "No Claude accounts are connected to this company yet. Add one under Connectors.",
  isDefault: "● Default",
  standby: "Standby",
  notConnected: "not connected",
  runs: (n: number) => `${n} ${n === 1 ? "run" : "runs"}`,
  tokens: (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n)) + " tokens",
  noRuns: "no runs",
  share: (p: number) => `${p}% of all agent spend in this period`,
  limitsTitle: "Claude limits",
  limitsLoading: "Asking Claude for limits…",
  limitName: (id: string): string => {
    if (id === "five_hour") return "Current session";
    if (id === "seven_day") return "Week, all models";
    const m = /^seven_day_([a-z]+)/.exec(id);
    if (m) return "Week, " + (MODEL_NAMES[m[1]] ?? m[1]);
    if (id === "extra_usage") return "Extra usage";
    return id;
  },
  used: (p: number) => `${p}% used`,
  resets: (when: string) => ` · resets ${when}`,
  fromRuns: (when: string) => `From the latest agent run on this account, ${when}`,
  fromClaude: (when: string) => `Reported by Claude at ${when}`,
  noLimitData: "No data yet. Press “Check limit” or wait for an agent to run on this account.",
  noLimitDataNoPatch:
    "No data yet. Claude does not give limits to Paperclip's sign-in, so they are read from agent runs — that needs the limits patch (see the plugin README: npm run limits:apply).",
  checkButton: "Check limit",
  checking: "Checking…",
  checkRunning: (agent?: string) => `A short run of ${agent ?? "the check agent"} is in progress on this account; this can take a couple of minutes.`,
  check: {
    done: "Checked, numbers updated.",
    slow: "The check run is taking longer than 3 minutes; numbers will appear when it finishes.",
    run_failed: (d?: string) => `The check run failed: ${d ?? "unknown error"}`,
    api_unreachable: "Paperclip's API did not answer, the check was not started.",
    no_probe: "The check agent no longer exists. Choose another one below.",
    probe_busy: (agent?: string) => `${agent ?? "The check agent"} is busy right now. Try again when it is idle.`,
    error: (d?: string) => `The check failed: ${d ?? "unknown error"}`,
    restore_failed: (agent?: string) => `Could not put ${agent ?? "the check agent"} back on its own account — please check its settings.`,
  },
  startErrors: {
    ALREADY_RUNNING: "Another account is being checked. Wait for it to finish.",
    NO_PROBE_AGENT: "Choose a check agent first (below the accounts).",
    API_UNREACHABLE: "Paperclip's API did not answer.",
    ACCOUNT_NOT_FOUND: "Account not found.",
    fallback: "The check did not start.",
  },
  workingNow: "Working now: ",
  nobodyWorking: "Nobody is working right now",
  agentFallback: "agent",
  makeDefault: "Make default",
  alreadyDefault: "Already default",
  switching: "Switching…",
  switchError: (name: string) => `Could not switch to “${name}”. Please try again.`,
  probeLabel: "Check agent",
  probeNone: "not chosen",
  autoTitle: "Auto-switch at",
  autoHelp:
    "When the default account reaches this share of any of its limits, new agent runs move to the least used account. Runs already in progress stay where they are. After a switch the plugin waits 30 minutes before switching again, and it does not switch back on its own.",
  autoStandby: "Standby check",
  autoStandbyOptions: { 0: "never", 30: "30 min", 60: "60 min" } as Record<number, string>,
  autoStandbyHelp:
    "How often the limits of accounts nobody is using are refreshed, so a switch lands on an account that really has room. Each refresh is one real, short run of the check agent on that account.",
  autoExclude: "Skip in auto-switch",
  autoNeedsPatch: "Auto-switch needs the limits patch: without it there is nothing to judge by.",
  autoNeedsProbe: "Standby checks need a check agent.",
  autoEvent: {
    switched: (at: string, from: string, to: string, what: string) => `${at}: switched from “${from}” to “${to}” (${what})`,
    no_candidate: (at: string, from: string, what: string) => `${at}: “${from}” reached the threshold (${what}), but every other account is at its limit too`,
    failed: (at: string, from: string, to: string) => `${at}: could not switch from “${from}” to “${to}”`,
  },
  autoLastCheck: (at: string, percent: number | null) => `checked ${at}` + (percent == null ? "" : ` · default at ${percent}%`),
  saveError: "Could not save the setting.",
  probeHint: "A check is one real, short run of this agent on the chosen account, so it uses a little of that account's limit. Pick an agent that is usually idle.",
  footer:
    "Spend is shown at API prices: what the same work would have cost without a subscription. Limits are Claude's own numbers; they arrive with agent runs and belong to the account the run used. Switching applies to new runs; runs already in progress finish on their previous account.",
  unmatched: (amount: string) => ` Another ${amount} belongs to accounts that were removed.`,
  pinTop: "Pin to top",
  pinTopOff: "Unpin from top",
  pinHelp: "Pinned: this block is shown above Paperclip's own dashboard panels. Unpinned: it stays where Paperclip puts plugin widgets.",
  helpLabel: "Help",
};

export type Strings = typeof en;
export const T: Strings = en;
