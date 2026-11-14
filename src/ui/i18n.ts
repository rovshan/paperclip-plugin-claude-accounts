// English by default; Russian when the browser language is Russian.
export type Lang = "en" | "ru";

export function detectLang(): Lang {
  const list = typeof navigator !== "undefined" ? [navigator.language, ...(navigator.languages ?? [])] : [];
  return list.some((l) => (l ?? "").toLowerCase().startsWith("ru")) ? "ru" : "en";
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

const MODEL_NAMES: Record<string, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", mythos: "Mythos" };

const en = {
  locale: "en-US",
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
  probeLabel: "Agent used for limit checks:",
  probeNone: "not chosen",
  probeHint: "A check is one real, short run of this agent on the chosen account, so it uses a little of that account's limit. Pick an agent that is usually idle.",
  footer:
    "Spend is shown at API prices: what the same work would have cost without a subscription. Limits are Claude's own numbers; they arrive with agent runs and belong to the account the run used. Switching applies to new runs; runs already in progress finish on their previous account.",
  unmatched: (amount: string) => ` Another ${amount} belongs to accounts that were removed.`,
  pinTop: "Show at the top of the dashboard",
  pinTopOff: "Show in the default place",
};

const ru: typeof en = {
  locale: "ru-RU",
  title: "Claude-аккаунты",
  selectCompany: "Выберите компанию.",
  defaultIs: (name) => `Новые запуски агентов идут через «${name}»`,
  noDefault: "Основной аккаунт не выбран",
  periodLabel: "Период расхода",
  periods: { today: "Сегодня", week: "7 дней", month: "Месяц", all: "Всё время" },
  totalCaption: "всего по ценам API",
  loadingAccounts: "Загружаю аккаунты…",
  loadError: "Не удалось получить список аккаунтов. Повторю через минуту.",
  costError: (m) => `Не удалось посчитать расход: ${m}`,
  noAccounts: "К этой компании пока не подключён ни один Claude-аккаунт. Добавьте его в разделе Connectors.",
  isDefault: "● Основной",
  standby: "В запасе",
  notConnected: "не подключён",
  runs: (n) => `${n} ${ruPlural(n, "запуск", "запуска", "запусков")}`,
  tokens: (n) =>
    (n >= 1e9
      ? `${(n / 1e9).toFixed(1).replace(".", ",")} млрд`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1).replace(".", ",")} млн`
        : n >= 1e3
          ? `${Math.round(n / 1e3)} тыс.`
          : String(n)) + " токенов",
  noRuns: "запусков не было",
  share: (p) => `${p}% общего расхода агентов за период`,
  limitsTitle: "Лимиты Claude",
  limitsLoading: "Запрашиваю лимиты у Claude…",
  limitName: (id) => {
    if (id === "five_hour") return "Текущая сессия";
    if (id === "seven_day") return "Неделя, все модели";
    const m = /^seven_day_([a-z]+)/.exec(id);
    if (m) return "Неделя, " + (MODEL_NAMES[m[1]] ?? m[1]);
    if (id === "extra_usage") return "Дополнительное использование";
    return id;
  },
  used: (p) => `использовано ${p}%`,
  resets: (when) => ` · сброс ${when}`,
  fromRuns: (when) => `По последнему запуску агента на этом аккаунте, ${when}`,
  fromClaude: (when) => `Данные Claude на ${when}`,
  noLimitData: "Данных пока нет. Нажмите «Проверить лимит» или дождитесь запуска агента на этом аккаунте.",
  noLimitDataNoPatch:
    "Данных пока нет. Claude не отдаёт лимиты входу Paperclip, поэтому они читаются из запусков агентов — для этого нужна правка лимитов (см. README плагина: npm run limits:apply).",
  checkButton: "Проверить лимит",
  checking: "Проверяю…",
  checkRunning: (agent) => `Идёт короткий запуск агента ${agent ?? "для проверки"} на этом аккаунте, до пары минут.`,
  check: {
    done: "Проверено, цифры обновлены.",
    slow: "Проверочный запуск идёт дольше 3 минут; цифры появятся, когда он закончится.",
    run_failed: (d) => `Проверочный запуск не прошёл: ${d ?? "неизвестная ошибка"}`,
    api_unreachable: "Paperclip не ответил, проверка не запущена.",
    no_probe: "Агента для проверки больше нет. Выберите другого ниже.",
    probe_busy: (agent) => `${agent ?? "Агент для проверки"} сейчас занят. Повторите, когда он освободится.`,
    error: (d) => `Проверка не удалась: ${d ?? "неизвестная ошибка"}`,
    restore_failed: (agent) => `Не удалось вернуть агента ${agent ?? ""} на его аккаунт — проверьте его настройки.`,
  },
  startErrors: {
    ALREADY_RUNNING: "Уже идёт проверка другого аккаунта, дождитесь её окончания.",
    NO_PROBE_AGENT: "Сначала выберите агента для проверки (под списком аккаунтов).",
    API_UNREACHABLE: "Paperclip не ответил.",
    ACCOUNT_NOT_FOUND: "Аккаунт не найден.",
    fallback: "Проверка не запустилась.",
  },
  workingNow: "Сейчас работают: ",
  nobodyWorking: "Сейчас никто не работает",
  agentFallback: "агент",
  makeDefault: "Сделать основным",
  alreadyDefault: "Уже основной",
  switching: "Переключаю…",
  switchError: (name) => `Не удалось переключить на «${name}». Попробуйте ещё раз.`,
  probeLabel: "Агент для проверки лимитов:",
  probeNone: "не выбран",
  probeHint: "Проверка — это один настоящий короткий запуск этого агента на выбранном аккаунте, она тратит немного его лимита. Выберите агента, который обычно свободен.",
  footer:
    "Расход показан по ценам API: столько стоила бы та же работа без подписки. Лимиты — настоящие цифры Claude: они приходят с запусками агентов и относятся к аккаунту, на котором шёл запуск. Переключение действует на новые запуски, уже идущие доработают на прежнем аккаунте.",
  unmatched: (amount) => ` Ещё ${amount} приходится на удалённые аккаунты.`,
  pinTop: "Показывать вверху дашборда",
  pinTopOff: "Показывать на обычном месте",
};

export type Strings = typeof en;
export const STRINGS: Record<Lang, Strings> = { en, ru };
