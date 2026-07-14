/**
 * Tmux Notification Extension
 *
 * Mirrors Claude Code's tmux notification:
 *  - writes a BEL (\a) to the pane's tty; tmux's monitor-bell raises the window
 *    flag and the terminal emulator plays the audible beep (visual-bell must
 *    stay OFF or the beep is swallowed).
 *  - also fires a desktop notification (notify-send) for parity with Claude's
 *    built-in OS Notification layer.
 *
 * Fires on two "ask-user" moments, matching Claude's Stop + Notification hooks:
 *   - agent_end: the agent finished a turn and is waiting for input
 *   - ask_user tool execution: the agent explicitly paused to ask a question
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync, execFile } from "node:child_process";

function isTmux(): boolean {
  return Boolean(process.env.TMUX);
}

function notify(): void {
  if (!isTmux()) return;

  try {
    const pane = process.env.TMUX_PANE || execSync("tmux display-message -p '#{pane_id}'", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const tty = execSync(`tmux display-message -p -t "${pane}" '#{pane_tty}'`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (tty) {
      execSync(`printf '\\a' > "${tty}" 2>/dev/null`, { stdio: "ignore" });
    }
  } catch {
    // Ignore errors
  }
}

/** Desktop notification (parity with Claude's OS Notification layer). No-op if notify-send is absent. */
function desktopNotify(title: string, body: string): void {
  try {
    const child = execFile(
      "notify-send",
      ["-a", "Pi", title, body],
      { stdio: "ignore" },
      () => {},
    );
    child.on("error", () => {});
  } catch {
    // notify-send unavailable; ignore
  }
}

/** True when a tool is the interactive ask-user tool. */
function isAskUserTool(toolName: string): boolean {
  return /^ask[-_]?user$/i.test(toolName);
}

export default function (pi: ExtensionAPI): void {
  // Agent finished a turn and is now waiting for the user (Claude's Stop hook).
  pi.on("agent_end", async () => {
    notify();
    desktopNotify("Pi", "Waiting for your input");
  });

  // The agent paused mid-turn to ask the user a structured question
  // (Claude's Notification hook: agent_needs_input / idle_prompt).
  pi.on("tool_execution_start", async (event) => {
    if (isAskUserTool(event.toolName)) {
      notify();
      desktopNotify("Pi", "Asking for your decision");
    }
  });
}
