import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const TASKS_CHANNEL = "@4fu/pi-tasks/v1";
export const TASKS_WIDGET_KEY = "pi-tasks-active";
export type TaskSource = "python" | "pwsh" | "subagent";
export type TaskPhase = "active" | "completed" | "failed" | "cancelled";
export interface PresentedTask { taskKey: string; source: TaskSource; taskId: string; phase: TaskPhase; statusLabel: string; createdAt: number; updatedAt: number; startedAt?: number; endedAt?: number; summary?: string; meta?: string }
export interface TaskTimingOptions { heartbeatMs?: number; participantStaleMs?: number; catalogStaleMs?: number; now?: () => number }
export interface TaskReporter { publishCatalog(sessionId: string, tasks: readonly PresentedTask[]): void; close(): void }

const CAP = 100;
type Wire =
  | { v: 1; type: "probe"; sessionId: string; token: string }
  | { v: 1; type: "owner"; token: string; participantId: string }
  | { v: 1; type: "participant"; sessionId: string; participantId: string; source: TaskSource; seenAt: number }
  | { v: 1; type: "catalog"; sessionId: string; participantId: string; source: TaskSource; observedAt: number; tasks: PresentedTask[]; omittedActive: number; omittedTerminal: number }
  | { v: 1; type: "leave"; sessionId: string; participantId: string };
interface Catalog { sessionId: string; participantId: string; source: TaskSource; observedAt: number; tasks: PresentedTask[]; omittedActive: number; omittedTerminal: number }
interface Aggregate { tasks: PresentedTask[]; activeTotal: number; omitted: number }

const source = (v: unknown): v is TaskSource => v === "python" || v === "pwsh" || v === "subagent";
const phase = (v: unknown): v is TaskPhase => v === "active" || v === "completed" || v === "failed" || v === "cancelled";
function text(v: unknown, max: number, required = false): string | undefined { if (typeof v !== "string" || (required && v.length === 0)) return undefined; return v.replace(/\r\n?/g, "\n").slice(0, max); }
function num(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined; }
function task(v: unknown, expected?: TaskSource): PresentedTask | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return;
  const x = v as Record<string, unknown>; const s = x.source; const p = x.phase;
  const taskKey = text(x.taskKey, 256, true), taskId = text(x.taskId, 128, true), statusLabel = text(x.statusLabel, 80, true);
  const createdAt = num(x.createdAt), updatedAt = num(x.updatedAt);
  if (!taskKey || !taskId || !statusLabel || !source(s) || (expected && s !== expected) || !phase(p) || createdAt === undefined || updatedAt === undefined) return;
  return { taskKey, source: s, taskId, phase: p, statusLabel, createdAt, updatedAt, startedAt: num(x.startedAt), endedAt: num(x.endedAt), summary: text(x.summary, 1000), meta: text(x.meta, 500) };
}
function wire(v: unknown): Wire | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return; const x = v as Record<string, unknown>;
  if (x.v !== 1 || typeof x.type !== "string") return;
  if (x.type === "owner" && typeof x.token === "string" && typeof x.participantId === "string") return { v: 1, type: "owner", token: x.token.slice(0, 128), participantId: x.participantId.slice(0, 128) };
  if (typeof x.sessionId !== "string") return; const sessionId = x.sessionId.slice(0, 256);
  if (x.type === "probe" && typeof x.token === "string") return { v: 1, type: "probe", sessionId, token: x.token.slice(0, 128) };
  if (x.type === "leave" && typeof x.participantId === "string") return { v: 1, type: "leave", sessionId, participantId: x.participantId.slice(0, 128) };
  if (x.type === "participant" && typeof x.participantId === "string" && source(x.source) && num(x.seenAt) !== undefined) return { v: 1, type: "participant", sessionId, participantId: x.participantId.slice(0, 128), source: x.source, seenAt: num(x.seenAt)! };
  if (x.type === "catalog" && typeof x.participantId === "string" && source(x.source) && num(x.observedAt) !== undefined && Array.isArray(x.tasks)) return { v: 1, type: "catalog", sessionId, participantId: x.participantId.slice(0, 128), source: x.source, observedAt: num(x.observedAt)!, tasks: x.tasks.slice(0, CAP).flatMap(y => { const t = task(y, x.source as TaskSource); return t ? [t] : []; }), omittedActive: Math.max(0, Math.floor(num(x.omittedActive) ?? 0)), omittedTerminal: Math.max(0, Math.floor(num(x.omittedTerminal) ?? 0)) };
  return;
}
function compare(a: PresentedTask, b: PresentedTask): number { return (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt) || a.source.localeCompare(b.source) || a.taskKey.localeCompare(b.taskKey); }
function cloneTask(t: PresentedTask): PresentedTask { return { ...t }; }
function duration(ms: number): string { const n = Math.max(0, ms); return n < 60_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.floor(n / 60_000)}m ${Math.round(n % 60_000 / 1000)}s`; }

class TasksWidget implements Component {
  constructor(private state: Aggregate, private readonly theme: Theme) {}
  setState(s: Aggregate): void { this.state = s; }
  render(width: number): string[] {
    if (width <= 0 || this.state.activeTotal === 0) return []; const active = this.state.tasks.filter(t => t.phase === "active").sort(compare).slice(0, 3);
    const left = this.theme.fg("accent", this.theme.bold(`Tasks · ${this.state.activeTotal} active`)); const hint = this.theme.fg("dim", "Run /tasks for details");
    const gap = width - visibleWidth(left) - visibleWidth(hint); const out = [truncateToWidth(gap > 0 ? `${left}${" ".repeat(gap)}${hint}` : left, width)];
    for (const t of active) { out.push(truncateToWidth(`${this.theme.fg("accent", `#${t.taskId}`)} ${t.source} · ${t.statusLabel}`, width)); const detail = t.summary || t.meta; if (detail) out.push(truncateToWidth(`   ${this.theme.fg("muted", "↳")} ${detail}`, width)); }
    const hidden = this.state.activeTotal - active.length; if (hidden > 0) out.push(truncateToWidth(this.theme.fg("dim", `… ${hidden} more`), width)); return out;
  }
  invalidate(): void {}
}
export class TasksViewer implements Component {
  private offset = 0; private page = 1; private max = 0;
  constructor(private readonly snapshot: Aggregate, private readonly tui: TUI, private readonly theme: Theme, private readonly close: () => void, private readonly openedAt = Date.now()) {}
  handleInput(d: string): void { if (matchesKey(d, Key.escape) || matchesKey(d, Key.ctrl("c"))) return this.close(); let n = this.offset; if (matchesKey(d, Key.up)) n--; else if (matchesKey(d, Key.down)) n++; else if (matchesKey(d, Key.pageUp)) n -= this.page; else if (matchesKey(d, Key.pageDown)) n += this.page; else if (matchesKey(d, Key.home)) n = 0; else if (matchesKey(d, Key.end)) n = this.max; else return; this.offset = Math.max(0, Math.min(this.max, n)); this.tui.requestRender(); }
  render(width: number): string[] { if (width <= 0) return []; const body = this.content(width); this.page = Math.max(1, this.tui.terminal.rows - 8); this.max = Math.max(0, body.length - this.page); this.offset = Math.min(this.offset, this.max); const border = this.theme.fg("borderMuted", "─".repeat(width)); return [truncateToWidth(this.theme.fg("accent", this.theme.bold(`Tasks · ${this.snapshot.activeTotal} active`)), width), border, ...body.slice(this.offset, this.offset + this.page), border, truncateToWidth(this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn · Home/End · Esc close"), width)]; }
  invalidate(): void {}
  private content(width: number): string[] { const groups: [string, TaskPhase[]][] = [["Active", ["active"]], ["Completed", ["completed"]], ["Failed / Orphaned", ["failed"]], ["Cancelled", ["cancelled"]]]; const out: string[] = []; if (this.snapshot.omitted) out.push(this.theme.fg("dim", `${this.snapshot.omitted} older task(s) omitted by source catalogs.`), ""); for (const [name, ps] of groups) { const ts = this.snapshot.tasks.filter(t => ps.includes(t.phase)).sort(compare); out.push(this.theme.fg("accent", this.theme.bold(`${name} (${ts.length})`)), ""); if (!ts.length) out.push(this.theme.fg("dim", "  None."), ""); for (const t of ts) { const end = t.endedAt ?? this.openedAt; const start = t.startedAt ?? t.createdAt; out.push(truncateToWidth(`  #${t.taskId} · ${t.source} · ${t.statusLabel} · ${duration(end - start)}`, width)); for (const detail of [t.summary, t.meta]) if (detail) for (const line of wrapTextWithAnsi(detail, Math.max(1, width - 4))) out.push(truncateToWidth(`    ${line}`, width)); out.push(""); } } return out; }
}

export function registerTaskReporter(pi: ExtensionAPI, reporterSource: TaskSource, options: TaskTimingOptions = {}): TaskReporter {
  const id = randomUUID(), heartbeatMs = options.heartbeatMs ?? 1000, participantStaleMs = options.participantStaleMs ?? 3500, catalogStaleMs = options.catalogStaleMs ?? 3500, now = options.now ?? Date.now;
  let eligible = false, owner = false, command = false, closed = false, mounted = false, sessionId: string | undefined, timer: NodeJS.Timeout | undefined, local: Catalog | undefined, widget: TasksWidget | undefined, tui: TUI | undefined, widgetContext: ExtensionContext | undefined, renderSignature: string | undefined;
  const participants = new Map<string, { sessionId: string; seenAt: number }>(), catalogs = new Map<string, Catalog>();
  const emit = (e: Wire) => pi.events.emit(TASKS_CHANNEL, e);
  function aggregate(): Aggregate { const n = now(); const best = new Map<string, PresentedTask>(); let omitted = 0, omittedActive = 0; for (const c of catalogs.values()) { if (c.sessionId !== sessionId || n - c.observedAt > catalogStaleMs) continue; omitted += c.omittedActive + c.omittedTerminal; omittedActive += c.omittedActive; for (const t of c.tasks) { const old = best.get(t.taskKey); if (!old || t.updatedAt > old.updatedAt || (t.updatedAt === old.updatedAt && `${t.source}:${t.taskId}` > `${old.source}:${old.taskId}`)) best.set(t.taskKey, t); } } const tasks = [...best.values()].sort((a,b) => a.phase === "active" && b.phase !== "active" ? -1 : a.phase !== "active" && b.phase === "active" ? 1 : compare(a,b)); return { tasks, activeTotal: tasks.filter(t => t.phase === "active").length + omittedActive, omitted }; }
  function render(): void { if (!owner || !widget || !tui) return; const next = aggregate(); const signature = JSON.stringify(next); if (signature === renderSignature) return; renderSignature = signature; widget.setState(next); tui.requestRender(); }
  function announce(replay = true): void { if (!eligible || !sessionId) return; emit({ v: 1, type: "participant", sessionId, participantId: id, source: reporterSource, seenAt: now() }); if (replay && local) emit({ v: 1, type: "catalog", ...local }); }
  const unsubscribe = pi.events.on(TASKS_CHANNEL, raw => { const e = wire(raw); if (!e) return; if (e.type === "probe") { if (owner && eligible && e.sessionId === sessionId) emit({ v: 1, type: "owner", token: e.token, participantId: id }); if (eligible && e.sessionId === sessionId) announce(); return; } if (e.type === "participant") participants.set(e.participantId, { sessionId: e.sessionId, seenAt: now() }); else if (e.type === "leave") { participants.delete(e.participantId); catalogs.delete(e.participantId); } else if (e.type === "catalog") catalogs.set(e.participantId, e); render(); });
  pi.on("session_start", (_event, ctx) => {
    if (closed) return;
    sessionId = ctx.sessionManager.getSessionId(); eligible = true; const token = randomUUID(); let acknowledged = false;
    const off = pi.events.on(TASKS_CHANNEL, raw => { const e = wire(raw); if (e?.type === "owner" && e.token === token) acknowledged = true; }); emit({ v: 1, type: "probe", sessionId, token }); off();
    if (!acknowledged && !owner) { owner = true; emit({ v: 1, type: "owner", token, participantId: id }); }
    if (owner && !command) { command = true; pi.registerCommand("tasks", { description: "Show all background tasks", handler: async (_args, commandCtx) => { if (commandCtx.mode !== "tui") return commandCtx.ui.notify("/tasks requires interactive mode", "error"); const snap = aggregate(); const copy: Aggregate = { ...snap, tasks: snap.tasks.map(cloneTask) }; await commandCtx.ui.custom<void>((viewTui, theme, _keys, done) => new TasksViewer(copy, viewTui, theme, done)); } }); }
    if (owner && ctx.mode === "tui") { mounted = true; widgetContext = ctx; ctx.ui.setWidget(TASKS_WIDGET_KEY, (newTui, theme) => { tui = newTui; const initial = aggregate(); renderSignature = JSON.stringify(initial); widget = new TasksWidget(initial, theme); return widget; }, { placement: "aboveEditor" }); }
    announce(); if (heartbeatMs > 0 && !timer) { timer = setInterval(() => { announce(); const n = now(); for (const [key,p] of participants) if (n-p.seenAt > participantStaleMs) { participants.delete(key); catalogs.delete(key); } render(); }, heartbeatMs); timer.unref?.(); }
  });
  function shutdown(ctx?: ExtensionContext): void { if (sessionId) emit({ v: 1, type: "leave", sessionId, participantId: id }); eligible = false; if (timer) clearInterval(timer); timer = undefined; local = undefined; participants.clear(); catalogs.clear(); if (owner && mounted) (ctx ?? widgetContext)?.ui.setWidget(TASKS_WIDGET_KEY, undefined); mounted = false; widget = undefined; tui = undefined; widgetContext = undefined; renderSignature = undefined; sessionId = undefined; }
  pi.on("session_shutdown", (_event, ctx) => shutdown(ctx));
  return { publishCatalog(sid, input) { if (closed || !sessionId || sid !== sessionId) return; const normalized = input.flatMap(v => { const t = task(v, reporterSource); return t ? [t] : []; }); const active = normalized.filter(t => t.phase === "active").sort(compare); const terminal = normalized.filter(t => t.phase !== "active").sort((a,b) => b.updatedAt-a.updatedAt || compare(a,b)); const kept = [...active.slice(0,CAP), ...terminal.slice(0, Math.max(0,CAP-active.length))]; local = { sessionId, participantId: id, source: reporterSource, observedAt: now(), tasks: kept, omittedActive: Math.max(0,active.length-CAP), omittedTerminal: Math.max(0, terminal.length-Math.max(0,CAP-active.length)) }; emit({ v: 1, type: "catalog", ...local }); }, close() { if (closed) return; closed = true; shutdown(); unsubscribe(); } };
}
