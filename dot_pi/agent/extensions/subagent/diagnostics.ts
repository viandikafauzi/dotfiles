/**
 * Diagnostic helpers for the subagent extension.
 *
 * Extracted into its own module so unit tests can import the pure
 * functions without dragging in the peer deps the main `subagent.ts`
 * needs. Keep this file free of peer-dep imports.
 */
import { homedir } from "node:os";

export interface FailureDiagnostics {
  errorMessage?: string;
  stopReason?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stderr?: string;
  activityTrail?: string;
  usageLine?: string;
  partialOutput?: string;
}

export interface ToolCallEvent {
  name: string;
  arguments: Record<string, unknown>;
}

export const STDERR_TAIL_BYTES = 2000;
export const MAX_ACTIVITY_LINE_CHARS = 256;
export const DEFAULT_MAX_ACTIVITY_EVENTS = 20;

export function truncateTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let truncated = s.length - maxChars;
  for (let i = 0; i < 3; i++) {
    const suffix = `…(${truncated} chars truncated)`;
    const keep = Math.max(0, maxChars - suffix.length);
    const actual = s.length - keep;
    if (actual === truncated) break;
    truncated = actual;
  }
  const suffix = `…(${truncated} chars truncated)`;
  const keep = Math.max(0, maxChars - suffix.length);
  return s.slice(0, keep) + suffix;
}

export interface ToolCallRenderOptions {
  maxLineChars: number;
  pathStyle: "full" | "collapsed";
  format?: "trail" | "widget";
}

export function collapsePath(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
  event: ToolCallEvent,
  opts: ToolCallRenderOptions,
): string {
  const { name, arguments: args } = event;
  const { maxLineChars, pathStyle, format = "trail" } = opts;
  const home = homedir();

  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;

  const resolvePath = (v: string): string =>
    pathStyle === "collapsed" ? collapsePath(v, home) : v;

  if (format === "widget") {
    let label: string;
    switch (name) {
      case "bash": {
        const cmd = str(args.command) ?? "...";
        const trimmed = cmd.length > 50 ? cmd.slice(0, 50) + "\u2026" : cmd;
        label = `$ ${trimmed}`;
        break;
      }
      case "read":
        label = `read ${resolvePath((str(args.file_path) ?? str(args.path) ?? "...") as string)}`;
        break;
      case "write":
        label = `write ${resolvePath((str(args.file_path) ?? str(args.path) ?? "...") as string)}`;
        break;
      case "edit":
        label = `edit ${resolvePath((str(args.file_path) ?? str(args.path) ?? "...") as string)}`;
        break;
      default:
        label = name;
    }
    return truncateTail(label, maxLineChars);
  }

  let detail: string;
  switch (name) {
    case "bash": {
      const cmd = str(args.command) ?? "";
      detail = `$ ${cmd}`;
      break;
    }
    case "read":
    case "write":
    case "edit":
      detail = resolvePath(str(args.file_path) ?? str(args.path) ?? "(no path)");
      break;
    case "grep": {
      const pattern = str(args.pattern) ?? "(no pattern)";
      const path = resolvePath(str(args.path) ?? ".");
      detail = `${pattern} in ${path}`;
      break;
    }
    case "find":
      detail = resolvePath(str(args.pattern) ?? str(args.path) ?? "(no pattern)");
      break;
    case "ls":
      detail = resolvePath(str(args.path) ?? ".");
      break;
    default:
      try {
        detail = JSON.stringify(args);
      } catch {
        detail = "(unserializable args)";
      }
  }
  return truncateTail(`- ${name}: ${detail}`, maxLineChars);
}

export function formatToolCallFull(
  event: ToolCallEvent,
  maxLineChars: number = MAX_ACTIVITY_LINE_CHARS,
): string {
  return formatToolCall(event, {
    maxLineChars,
    pathStyle: "full",
    format: "trail",
  });
}

export function buildActivityTrail(
  events: readonly ToolCallEvent[],
  opts: {
    maxEvents?: number;
    maxLineChars?: number;
    eventsFile?: string;
  } = {},
): string {
  if (events.length === 0) return "";
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_ACTIVITY_EVENTS;
  if (maxEvents <= 0) return "";
  const maxLineChars = opts.maxLineChars ?? MAX_ACTIVITY_LINE_CHARS;

  const total = events.length;
  const shown = total > maxEvents ? events.slice(total - maxEvents) : events;
  const elided = total - shown.length;

  const headerParts: string[] = [`${total} tool call${total === 1 ? "" : "s"}`];
  if (elided > 0) {
    headerParts.push(`showing last ${shown.length}`);
    if (opts.eventsFile) {
      headerParts.push(`older ${elided} in ${opts.eventsFile}`);
    } else {
      headerParts.push(`${elided} older elided`);
    }
  } else if (opts.eventsFile) {
    headerParts.push(`full events in ${opts.eventsFile}`);
  }
  const header = `**Activity (${headerParts.join("; ")}):**`;

  const lines = shown.map((e) => formatToolCallFull(e, maxLineChars));
  return `${header}\n\n${lines.join("\n")}`;
}

export function fenceFor(content: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96) {
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function formatFailureBody(d: FailureDiagnostics): string {
  const parts: string[] = [];

  if (d.errorMessage && d.errorMessage.trim()) {
    parts.push(`**Error:** ${d.errorMessage.trim()}`);
  }

  const meta: string[] = [];
  if (d.stopReason && d.stopReason.trim() !== "end_turn") meta.push(`stop=${d.stopReason.trim()}`);
  if (d.exitCode !== undefined && d.exitCode !== 0) meta.push(`exit=${d.exitCode}`);
  if (d.signal) meta.push(`signal=${d.signal}`);
  if (meta.length > 0) parts.push(`**Status:** ${meta.join(", ")}`);

  const stderrTrimmed = (d.stderr || "").trim();
  if (stderrTrimmed) {
    const tail =
      stderrTrimmed.length > STDERR_TAIL_BYTES
        ? `…(truncated; tail ${STDERR_TAIL_BYTES} bytes)\n${stderrTrimmed.slice(-STDERR_TAIL_BYTES)}`
        : stderrTrimmed;
    const fence = fenceFor(tail);
    parts.push(`**stderr:**\n\n${fence}\n${tail}\n${fence}`);
  }

  if (d.activityTrail && d.activityTrail.trim()) {
    parts.push(d.activityTrail.trim());
  }

  if (d.usageLine && d.usageLine.trim()) {
    parts.push(`**Usage before failure:** ${d.usageLine.trim()}`);
  }

  const partialOutputTrimmed = (d.partialOutput || "").trim();
  if (partialOutputTrimmed && partialOutputTrimmed !== "(no output)") {
    parts.push(`**Partial output:**\n\n${partialOutputTrimmed}`);
  }

  return parts.length === 0
    ? "(no diagnostic information captured — check the post-mortem .jsonl)"
    : parts.join("\n\n");
}
