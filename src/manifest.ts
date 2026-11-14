import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-claude-accounts",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Claude Accounts",
  description:
    "Dashboard widget for Claude subscription accounts: real usage limits, API-equivalent spend per account, who is running where, one-click and automatic switching of the default account.",
  author: "Rovshan Shirinov",
  categories: ["ui"],
  capabilities: [
    "ui.dashboardWidget.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
  ],
  jobs: [
    {
      jobKey: "auto-switch",
      displayName: "Auto-switch and standby checks",
      description: "Every 5 minutes: refreshes limits of standby accounts and switches the default account when it reaches the threshold. Does nothing unless auto-switch is turned on in the widget.",
      schedule: "*/5 * * * *",
    },
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["cost_events", "heartbeat_runs"],
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "claude-accounts",
        displayName: "Claude Accounts",
        exportName: "ClaudeAccountsWidget",
      },
    ],
  },
};

export default manifest;
