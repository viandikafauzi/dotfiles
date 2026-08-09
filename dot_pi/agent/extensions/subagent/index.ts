/**
 * Subagent Extension — fire-and-forget with streaming progress.
 *
 * Two modes:
 *   - background (default): Spawns `pi --mode json -p --no-session`.
 *     Returns immediately. Parses JSON events in background for live
 *     widget updates. Injects result via sendMessage when done.
 *   - interactive: Uses Herdr to spawn pi in a managed pane.
 *     User can switch to the pane and steer the agent.
 *     Results auto-inject when complete.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@earendil-works/pi-ai";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile, unlink, access } from "node:fs/promises";
import { existsSync, writeFileSync, createWriteStream, type WriteStream } from "node:fs";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  buildActivityTrail,
  formatFailureBody,
  formatToolCall,
  type ToolCallEvent,
} from "./diagnostics.js";

// ── Types ──────────────────────────────────────────────────────────────

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface TrackedRun {
  id: string;
  task: string;
  mode: "background" | "interactive";
  startTime: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  // Background-only streaming state
  messages: Message[];
  usage: Usage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  lastToolCall?: string;
  proc?: ChildProcess;
  // Interactive-only (Herdr)
  herdrTabId?: string;
  herdrPaneId?: string;
  herdrAgentName?: string;
  resultFile?: string;
  watcher?: ReturnType<typeof setInterval>;
  // Timeout
  timeoutMs?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsage(u: Usage, model?: string): string {
  const p: string[] = [];
  if (u.turns) p.push(`${u.turns}t`);
  if (u.input) p.push(`↑${formatTokens(u.input)}`);
  if (u.output) p.push(`↓${formatTokens(u.output)}`);
  if (u.cost) p.push(`$${u.cost.toFixed(3)}`);
  if (model) p.push(model);
  return p.join(" ");
}

function getFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const texts: string[] = [];
      for (const part of msg.content) {
        if (part.type === "text") texts.push(part.text);
      }
      if (texts.length > 0) return texts.join("").trim();
    }
  }
  return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = (process.execPath.split("/").pop() || "").toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function elapsedStr(start: number, end?: number): string {
  const s = ((end || Date.now()) - start) / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
}

// ── Herdr helpers ──────────────────────────────────────────────────────

async function herdrJson(args: string[], timeoutMs = 15000): Promise<any> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("herdr", args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface HerdrTab {
  tabId: string;
  paneId: string;
}

async function herdrTabCreate(cwd: string, label: string): Promise<HerdrTab | null> {
  const res = await herdrJson([
    "tab", "create",
    "--cwd", cwd,
    "--no-focus",
    "--label", label,
  ]);
  const tabId = res?.result?.tab?.tab_id;
  const paneId = res?.result?.root_pane?.pane_id;
  if (!tabId || !paneId) return null;
  return { tabId, paneId };
}

async function herdrTabClose(tabId: string): Promise<void> {
  await herdrJson(["tab", "close", tabId]);
}

async function herdrAgentStart(name: string, paneId: string): Promise<boolean> {
  // Retry — the shell needs a moment to be ready after tab creation
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await herdrJson([
      "agent", "start", name,
      "--kind", "pi",
      "--pane", paneId,
      "--timeout", "15000",
    ], 20000);
    if (res?.result?.agent) return true;
    // Wait 2s before retry (async, non-blocking)
    await sleepMs(2000);
  }
  return false;
}

async function herdrAgentPrompt(name: string, task: string): Promise<boolean> {
  const res = await herdrJson([
    "agent", "prompt", name, task,
    "--wait", "--timeout", "120000",
  ], 130000);
  return !!res?.result;
}

async function herdrAgentRead(name: string): Promise<string> {
  try {
    const res = await herdrJson([
      "agent", "read", name,
      "--source", "recent-unwrapped",
      "--lines", "200",
    ], 10000);
    return res?.result?.output ?? "";
  } catch {
    return "";
  }
}

async function herdrAgentGet(name: string): Promise<{ status?: string; alive: boolean }> {
  const res = await herdrJson(["agent", "get", name]);
  if (!res?.result?.agent) return { alive: false };
  return { status: res.result.agent.agent_status, alive: true };
}



// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const active = new Map<string, TrackedRun>();
  let widgetCtx: any = null;

  // ── Widget: live status of all running subagents ──

  function updateWidget() {
    if (!widgetCtx) return;
    const running = [...active.values()].filter((r) => r.exitCode === undefined);
    if (running.length === 0) {
      widgetCtx.ui.setWidget("subagent-status", undefined);
      return;
    }

    widgetCtx.ui.setWidget("subagent-status", (_tui: any, theme: any) => {
      const lines = running.map((r) => {
        const elapsed = elapsedStr(r.startTime);
        const icon = r.mode === "interactive" ? "🖥" : "⏳";
        const activity = r.lastToolCall
          ? theme.fg("dim", ` → ${r.lastToolCall}`)
          : theme.fg("dim", " starting…");
        const usage = r.usage.turns > 0 ? theme.fg("muted", ` [${formatUsage(r.usage)}]`) : "";
        const tab = r.herdrTabId ? theme.fg("dim", ` [${r.herdrTabId}]`) : "";
        return `${icon} ${theme.fg("accent", r.id)} ${theme.fg("dim", elapsed)}${activity}${usage}${tab}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    });
  }

  // ── Kill/cleanup helper ──

  async function killRun(run: TrackedRun, reason: "killed" | "timeout"): Promise<void> {
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run.watcher) clearInterval(run.watcher);

    if (run.mode === "background" && run.proc) {
      try { run.proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { run.proc?.kill("SIGKILL"); } catch {} }, 5000);
    }

    if (run.mode === "interactive" && run.herdrTabId) {
      // Send Ctrl+C then close the tab
      try { await herdrJson(["agent", "send-keys", run.herdrAgentName || "", "ctrl+c"], 5000); } catch {}
      await sleepMs(1000);
      try { await herdrTabClose(run.herdrTabId!); } catch {}
    }

    run.exitCode = reason === "timeout" ? 124 : 130;
    run.finishedAt = Date.now();
    const elapsed = elapsedStr(run.startTime, run.finishedAt);
    active.delete(run.id);
    updateWidget();

    const label = reason === "timeout"
      ? `timed out after ${Math.round((run.timeoutMs || 0) / 60000)}min`
      : "killed by user";

    pi.sendMessage(
      {
        customType: "subagent-result",
        content: `## Subagent \`${run.id}\` ${label} (${elapsed})\n\nThe subagent was ${label}.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }

  // ── Background mode: fire-and-forget with JSON streaming ──

  function spawnBackground(
    id: string,
    task: string,
    cwd: string,
  ): TrackedRun {
    const run: TrackedRun = {
      id,
      task,
      mode: "background",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
    };

    const framedTask = [
      "IMPORTANT: You are running as a subagent. Do NOT spawn sub-subagents — do all the work yourself directly.",
      "",
      task,
    ].join("\n");
    const piArgs: string[] = ["--mode", "json", "-p", "--no-session", framedTask];
    const invocation = getPiInvocation(piArgs);

    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.proc = proc;

    const eventsPath = `/tmp/subagent-${id}-events.jsonl`;
    let eventStream: WriteStream | undefined;
    try {
      eventStream = createWriteStream(eventsPath, { flags: "w" });
      eventStream.on("error", () => {
        try { eventStream?.destroy(); } catch {}
        eventStream = undefined;
      });
    } catch {
      eventStream = undefined;
    }

    let buffer = "";
    let stderr = "";
    let completed = false;

    const finishRun = (code: number) => {
      if (completed) return;
      if (run.timeoutTimer) { clearTimeout(run.timeoutTimer); run.timeoutTimer = undefined; }
      completed = true;
      if (buffer.trim()) processLine(buffer);
      run.exitCode = code;
      run.finishedAt = Date.now();

      try { eventStream?.end(); } catch {}

      const elapsed = elapsedStr(run.startTime, run.finishedAt);
      const output = getFinalText(run.messages);
      const isError =
        run.exitCode !== 0 ||
        run.signal !== undefined ||
        run.stopReason === "error" ||
        run.stopReason === "aborted";

      const resultPath = `/tmp/subagent-${id}-result.md`;
      try { writeFileSync(resultPath, output || "(no output)"); } catch {}

      const usageStr = formatUsage(run.usage, run.model);
      let content: string;
      if (isError) {
        const events: ToolCallEvent[] = [];
        for (const msg of run.messages) {
          if (msg.role !== "assistant") continue;
          for (const part of msg.content) {
            if (part.type === "toolCall") {
              events.push({
                name: part.name,
                arguments: part.arguments as Record<string, unknown>,
              });
            }
          }
        }
        const activityTrail = buildActivityTrail(events, {
          eventsFile: eventStream ? eventsPath : undefined,
        });
        const body = formatFailureBody({
          errorMessage: run.errorMessage,
          stopReason: run.stopReason,
          exitCode: run.exitCode,
          signal: run.signal,
          stderr,
          activityTrail,
          usageLine: run.usage.turns > 0 ? usageStr : undefined,
          partialOutput: output,
        });
        const footer = eventStream
          ? `_Post-mortem: \`jq . < ${eventsPath}\`_`
          : "";
        content = `## Subagent \`${id}\` failed (${elapsed})\n\n${body}${footer ? `\n\n${footer}` : ""}`;
      } else {
        content = `## Subagent \`${id}\` completed (${elapsed}, ${usageStr})\n\n${output}`;
      }

      active.delete(id);
      updateWidget();

      try { proc.kill(); } catch {}

      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }

      if (event.type === "agent_end") {
        finishRun(0);
        return;
      }
      if (event.type === "turn_end" && event.message) {
        const msg = event.message as AssistantMessage;
        const hasToolCall = Array.isArray(msg.content) && msg.content.some((p: any) => p.type === "toolCall");
        const errored = msg.stopReason === "error" || msg.stopReason === "aborted";
        if (!hasToolCall && !errored) {
          finishRun(0);
          return;
        }
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        run.messages.push(msg);
        if (msg.role === "assistant") {
          run.usage.turns++;
          const u = msg.usage;
          if (u) {
            run.usage.input += u.input || 0;
            run.usage.output += u.output || 0;
            run.usage.cacheRead += u.cacheRead || 0;
            run.usage.cacheWrite += u.cacheWrite || 0;
            run.usage.cost += u.cost?.total || 0;
          }
          if (!run.model && msg.model) run.model = msg.model;
          if (msg.stopReason) run.stopReason = msg.stopReason;
          if (msg.errorMessage) run.errorMessage = msg.errorMessage;

          for (const part of msg.content) {
            if (part.type === "toolCall") {
              run.lastToolCall = formatToolCall(
                { name: part.name, arguments: part.arguments as Record<string, unknown> },
                { maxLineChars: 80, pathStyle: "collapsed", format: "widget" },
              );
            }
          }
        }
        updateWidget();
      }

      if (event.type === "tool_result_end" && event.message) {
        run.messages.push(event.message as Message);
        updateWidget();
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      try { eventStream?.write(data); } catch {}
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code, signal) => {
      if (signal) run.signal = signal;
      finishRun(code ?? 0);
    });

    proc.on("error", () => {
      run.errorMessage = "Failed to spawn pi process";
      finishRun(1);
    });

    proc.unref();
    return run;
  }

  // ── Interactive mode: Herdr ──

  async function spawnInteractive(id: string, task: string, cwd: string): Promise<TrackedRun> {
    const agentName = `sub-${id.slice(0, 24)}`; // herdr names max 32 chars
    const resultFile = `/tmp/subagent-${id}-result.md`;

    // 1. Create a new background tab
    const tab = await herdrTabCreate(cwd, `sub-${id.slice(0, 20)}`);
    if (!tab) {
      throw new Error("Failed to create Herdr tab. Is Herdr running?");
    }

    // 2. Start pi agent in the tab's root pane
    const started = await herdrAgentStart(agentName, tab.paneId);
    if (!started) {
      await herdrTabClose(tab.tabId);
      throw new Error(`Failed to start pi agent in tab ${tab.tabId}`);
    }

    const run: TrackedRun = {
      id,
      task,
      mode: "interactive",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
      herdrTabId: tab.tabId,
      herdrPaneId: tab.paneId,
      herdrAgentName: agentName,
      resultFile,
    };

    // 3. Send the task via herdr agent prompt (async, non-blocking)
    const framedTask = `${task}

When you have completed the task, do these two things:
1. Use the write tool to save your complete findings/summary to ${resultFile}
2. Then say "SUBAGENT COMPLETE" so I know you're done.`;

    // Fire prompt in background — don't await, let watcher handle completion
    herdrAgentPrompt(agentName, framedTask).catch(() => {
      // Prompt send failed — agent may have exited; watcher will detect
    });

    // 4. Watch for completion: poll herdr agent state + result file
    const injectResult = async () => {
      const elapsed = elapsedStr(run.startTime);
      if (run.timeoutTimer) { clearTimeout(run.timeoutTimer); run.timeoutTimer = undefined; }
      if (run.watcher) clearInterval(run.watcher);
      active.delete(run.id);
      updateWidget();

      let content: string;
      try {
        const result = await readFile(resultFile, "utf8");
        content = `## Subagent \`${id}\` completed (${elapsed})\n\n${result}`;
      } catch {
        // Try reading from Herdr pane output
        const paneOutput = await herdrAgentRead(agentName);
        if (paneOutput) {
          content = `## Subagent \`${id}\` completed (${elapsed})\n\n${paneOutput}`;
        } else {
          content = `## Subagent \`${id}\` failed (${elapsed})\n\nNo output.`;
        }
      }

      // Clean up the tab
      try { await herdrTabClose(tab.tabId); } catch {}

      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
      unlink(resultFile).catch(() => {});
    };

    // Poll every 3s for faster detection
    let pollCount = 0;
    const maxPolls = Math.ceil((run.timeoutMs || 600_000) / 3000);
    run.watcher = setInterval(async () => {
      pollCount++;

      // Check if result file exists (agent wrote it)
      let resultExists = false;
      try { await access(resultFile); resultExists = true; } catch {}

      if (resultExists) {
        // Give it a moment for the agent to finish writing
        await sleepMs(1000);
        await injectResult();
        return;
      }

      // Check if agent is still alive via Herdr (less frequently to reduce CLI overhead)
      if (pollCount % 2 === 0) {
        const agentState = await herdrAgentGet(agentName);
        if (!agentState.alive) {
          // Agent exited — read whatever output we can
          await injectResult();
          return;
        }
      }

      // Safety valve: if we've been polling too long, give up
      if (pollCount >= maxPolls) {
        await injectResult();
      }
    }, 3000);

    return run;
  }

  // ── Lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    widgetCtx = ctx;
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    }
    active.clear();
  });

  pi.on("session_shutdown", async () => {
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    }
    widgetCtx = null;
  });

  pi.on("turn_start", async (_event, ctx) => {
    widgetCtx = ctx;
  });

  // ── Tools ──

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a background pi subagent to work on a task. " +
      "Returns immediately — the subagent runs in the background with full tool access. " +
      "Live progress shown in a widget. Results auto-inject when complete. " +
      "Use for research, analysis, code review, data gathering — anything that can run independently.",
    promptSnippet: "Spawn background pi subagent — results auto-inject when done",
    promptGuidelines: [
      "Use subagent for independent tasks (research, analysis, review) that don't need user interaction",
      "Keep subagent tasks focused and self-contained — include all context the subagent needs",
      "Use short descriptive IDs like 'cr-review', 'coverage', 'pipeline-check'",
      "Max 3-4 concurrent subagents to avoid rate limits",
      "Subagent results arrive as messages — you'll get a turn to incorporate them",
      "Interactive mode spawns pi in a Herdr pane the user can switch to and steer, with results still auto-injecting when done",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Short descriptive ID for this subagent (e.g. 'cr-review', 'coverage-check', 'error-research')",
      }),
      task: Type.String({
        description: "Detailed task description. Be specific — include file paths, URLs, criteria. The subagent has full tool access.",
      }),
      workingDir: Type.Optional(
        Type.String({ description: "Working directory for the subagent (default: current directory)" })
      ),
      interactive: Type.Optional(
        Type.Boolean({
          description: "If true, spawns pi in a Herdr pane the user can switch to. Default: true.",
          default: true,
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in minutes. Subagent is auto-killed when exceeded. Default: 10.",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { id, task, timeout } = params;
      const interactive = params.interactive !== false; // default true
      const cwd = params.workingDir || ctx.cwd;
      widgetCtx = ctx;

      if (active.has(id)) {
        throw new Error(`Subagent '${id}' is already running. Use a different ID or wait for it to finish.`);
      }

      const timeoutMs = (timeout || 10) * 60_000;

      if (interactive) {
        const run = await spawnInteractive(id, task, cwd);
        run.timeoutMs = timeoutMs;
        run.timeoutTimer = setTimeout(() => { killRun(run, "timeout").catch(() => {}); }, timeoutMs);
        active.set(id, run);
        updateWidget();

        return {
          content: [{
            type: "text" as const,
            text: `Subagent '${id}' spawned in Herdr tab ${run.herdrTabId}. Switch to it in the Herdr TUI.\nResults will auto-inject when complete.`,
          }],
          details: { id, mode: "interactive", tabId: run.herdrTabId, paneId: run.herdrPaneId, agentName: run.herdrAgentName, cwd },
        };
      }

      const run = spawnBackground(id, task, cwd);
      run.timeoutMs = timeoutMs;
      run.timeoutTimer = setTimeout(() => { killRun(run, "timeout").catch(() => {}); }, timeoutMs);
      active.set(id, run);
      updateWidget();

      return {
        content: [{
          type: "text" as const,
          text: `Subagent '${id}' spawned in background. Live progress in widget above. Results will auto-inject when complete.`,
        }],
        details: { id, mode: "background", cwd },
      };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "Check the status of running subagents",
    promptSnippet: "Check running subagent status",
    parameters: Type.Object({}),

    async execute() {
      if (active.size === 0) {
        return {
          content: [{ type: "text" as const, text: "No subagents currently running." }],
          details: { count: 0 as number, ids: [] as string[] },
        };
      }

      const lines = Array.from(active.entries()).map(([id, run]) => {
        const elapsed = elapsedStr(run.startTime);
        const mode = run.mode === "interactive" ? "herdr" : "bg";
        const activity = run.lastToolCall ? ` — ${run.lastToolCall}` : "";
        const usage = run.usage.turns > 0 ? ` [${formatUsage(run.usage)}]` : "";
        const tab = run.herdrTabId ? ` — tab \`${run.herdrTabId}\`` : "";
        return `- **${id}** [${mode}] ${elapsed}${activity}${usage}${tab}`;
      });

      return {
        content: [{
          type: "text" as const,
          text: `**${active.size} subagent(s) running:**\n${lines.join("\n")}`,
        }],
        details: { count: active.size, ids: Array.from(active.keys()) },
      };
    },
  });

  pi.registerTool({
    name: "subagent_kill",
    label: "Kill Subagent",
    description: "Terminate a running subagent by ID",
    promptSnippet: "Kill a running subagent",
    parameters: Type.Object({
      id: Type.String({
        description: "ID of the subagent to kill",
      }),
    }),

    async execute(_toolCallId, params) {
      const { id } = params;
      const run = active.get(id);
      if (!run) {
        throw new Error(`No subagent with ID '${id}' found. It may have already completed.`);
      }
      if (run.exitCode !== undefined) {
        throw new Error(`Subagent '${id}' has already finished.`);
      }

      killRun(run, "killed").catch(() => {});

      return {
        content: [{
          type: "text" as const,
          text: `Subagent '${id}' has been killed.`,
        }],
        details: { id, killed: true },
      };
    },
  });
}
