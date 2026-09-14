import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const TASKS_CHANNEL = "@4fu/pi-tasks/v1";
export const TASKS_CONTROL_CHANNEL = "@4fu/pi-tasks/control/v1";
export type TaskAction = "inspect" | "stop" | "delete";
export interface TaskControls { inspect(taskId: string): Promise<string>; stop?(taskId: string): Promise<string>; delete?(taskId: string): Promise<string> }
export const TASKS_WIDGET_KEY = "pi-tasks-active";
export type TaskSource = "python" | "pwsh" | "subagent";
export type TaskPhase = "active" | "completed" | "failed" | "cancelled";
export interface PresentedTask { taskKey: string; source: TaskSource; taskId: string; phase: TaskPhase; statusLabel: string; createdAt: number; updatedAt: number; startedAt?: number; endedAt?: number; summary?: string; meta?: string; actions?: TaskAction[] }
export interface TaskTimingOptions { heartbeatMs?: number; participantStaleMs?: number; catalogStaleMs?: number; now?: () => number; controls?: TaskControls; controlTimeoutMs?: number }
export interface TaskReporter { publishCatalog(sessionId: string, tasks: readonly PresentedTask[]): void; close(): void }

const CAP = 100;
const WIDGET_REVEAL_MS = 5_000;
const WIDGET_LINGER_MS = 5_000;
type Wire =
  | { v: 1; type: "probe"; sessionId: string; token: string }
  | { v: 1; type: "owner"; token: string; participantId: string }
  | { v: 1; type: "participant"; sessionId: string; participantId: string; source: TaskSource; seenAt: number }
  | { v: 1; type: "catalog"; sessionId: string; participantId: string; source: TaskSource; observedAt: number; tasks: PresentedTask[]; omittedActive: number; omittedTerminal: number }
  | { v: 1; type: "leave"; sessionId: string; participantId: string };
interface Catalog { sessionId: string; participantId: string; source: TaskSource; observedAt: number; tasks: PresentedTask[]; omittedActive: number; omittedTerminal: number }
interface RoutedTask extends PresentedTask { participantId?: string }
interface Aggregate { tasks: RoutedTask[]; activeTotal: number; omitted: number }
interface ControlAddress { sessionId: string; participantId: string; requesterId: string; taskKey: string; taskId: string; source: TaskSource; requestId: string; action: TaskAction }
type ControlWire = ControlAddress & ({ v: 1; type: "request" } | { v: 1; type: "reply"; ok: boolean; output: string });
const OUTPUT_CAP = 16_000;
// Treat output as plain text: no terminal commands, hyperlinks, or bidi controls.
function plain(value: string): string {
  const limited = value.length > OUTPUT_CAP ? `${value.slice(0, OUTPUT_CAP - 32)} [output truncated]` : value;
  return limited.replace(/\r\n?/g, "\n").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
function controlWire(value: unknown): ControlWire | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const x = value as Record<string, unknown>;
  if (x.v !== 1 || (x.type !== "request" && x.type !== "reply") || !source(x.source) || (x.action !== "inspect" && x.action !== "stop" && x.action !== "delete")) return;
  for (const key of ["sessionId", "participantId", "requesterId", "taskKey", "taskId", "requestId"]) if (typeof x[key] !== "string" || !x[key] || (x[key] as string).length > 256) return;
  if (x.type === "reply" && (typeof x.ok !== "boolean" || typeof x.output !== "string")) return;
  return { v: 1, type: x.type, sessionId: x.sessionId, participantId: x.participantId, requesterId: x.requesterId, taskKey: x.taskKey, taskId: x.taskId, requestId: x.requestId, source: x.source, action: x.action, ...(x.type === "reply" ? { ok: x.ok, output: plain(x.output as string) } : {}) } as ControlWire;
}
function sameAddress(a: ControlAddress, b: ControlAddress): boolean {
  return a.sessionId === b.sessionId && a.participantId === b.participantId && a.requesterId === b.requesterId && a.taskKey === b.taskKey && a.taskId === b.taskId && a.source === b.source && a.requestId === b.requestId && a.action === b.action;
}
interface WidgetRecord { task: PresentedTask; revealed: boolean; terminalAt?: number }

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
  const actions: TaskAction[] = Array.isArray(x.actions) ? ["inspect", p === "active" ? "stop" : "delete"].filter(a => (x.actions as unknown[]).includes(a)) as TaskAction[] : [];
  return { taskKey, source: s, taskId, phase: p, statusLabel, createdAt, updatedAt, startedAt: num(x.startedAt), endedAt: num(x.endedAt), summary: text(x.summary, 1000), meta: text(x.meta, 500), ...(actions.length ? { actions } : {}) };
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
function identity(t: RoutedTask): string { return JSON.stringify([t.participantId, t.source, t.taskKey, t.taskId]); }
function supports(t: PresentedTask | undefined, action: TaskAction): boolean { return !!t?.actions?.includes(action) && (action === "inspect" || (action === "stop" ? t.phase === "active" : t.phase !== "active")); }
function duration(ms: number): string { const n = Math.max(0, ms); return n < 60_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.floor(n / 60_000)}m ${Math.round(n % 60_000 / 1000)}s`; }

class TasksWidget implements Component {
  constructor(private state: Aggregate, private readonly theme: Theme) {}
  setState(s: Aggregate): void { this.state = s; }
  render(width: number): string[] {
    if (width <= 0 || this.state.tasks.length === 0) return []; const visible = this.state.tasks.slice(0, 3);
    const left = this.theme.fg("accent", this.theme.bold(`Tasks · ${this.state.activeTotal} active`)); const hint = this.theme.fg("dim", "Run /tasks for details");
    const gap = width - visibleWidth(left) - visibleWidth(hint); const out = [truncateToWidth(gap > 0 ? `${left}${" ".repeat(gap)}${hint}` : left, width)];
    for (const t of visible) { out.push(truncateToWidth(`${this.theme.fg("accent", `#${t.taskId}`)} ${t.source} · ${t.statusLabel}`, width)); const detail = t.summary || t.meta; if (detail) out.push(truncateToWidth(`   ${this.theme.fg("muted", "↳")} ${detail}`, width)); }
    const hidden = this.state.tasks.length - visible.length; if (hidden > 0) out.push(truncateToWidth(this.theme.fg("dim", `… ${hidden} more`), width)); return out;
  }
  invalidate(): void {}
}
export class TasksViewer implements Component {
  private selected?: string; private index = 0; private offset = 0; private page = 1; private max = 0;
  private mode: "list" | "detail" | "confirm" | "clear" = "list";
  private target?: RoutedTask; private output = ""; private busy = false; private generation = 0; private disposed = false;
  private inactive = false; private stopped?: string;
  private batch: RoutedTask[] = [];
  constructor(private readonly snapshot: Aggregate | (() => Aggregate), private readonly tui: TUI, private readonly theme: Theme, private readonly close: () => void, private readonly openedAt = Date.now(), private readonly act?: (task: RoutedTask, action: TaskAction) => Promise<string>) {}
  dispose(): void { this.disposed = true; this.generation++; }
  dismiss(): void { if (this.disposed) return; this.dispose(); try { this.close(); } catch { /* Session UI may already be gone. */ } }
  update(): void {
    if (this.disposed) return;
    if (this.stopped) {
      const state = typeof this.snapshot === "function" ? this.snapshot() : this.snapshot;
      if (state.tasks.some(t => identity(t) === this.stopped && t.phase !== "active")) {
        this.stopped = undefined; this.inactive = false; this.mode = "list"; this.offset = 0;
        if (state.activeTotal === 0) { this.dismiss(); return; }
      }
    }
    try { this.tui.requestRender(); } catch { this.dispose(); }
  }
  private listed(state: Aggregate): RoutedTask[] { return state.tasks.filter(t => (t.phase !== "active") === this.inactive); }
  private state(): Aggregate {
    const state = typeof this.snapshot === "function" ? this.snapshot() : this.snapshot;
    const tasks = this.listed(state);
    const found = tasks.findIndex(t => identity(t) === this.selected);
    this.index = found >= 0 ? found : Math.max(0, Math.min(this.index, tasks.length - 1));
    this.selected = tasks[this.index] ? identity(tasks[this.index]) : undefined;
    return state;
  }
  private inspect(t: RoutedTask): void {
    this.target = t; this.mode = "detail"; this.offset = 0;
    if (t.actions?.includes("inspect") && this.act) { this.run(t, "inspect"); return; }
    this.output = plain([`#${t.taskId} · ${t.source} · ${t.statusLabel}`, `Duration: ${duration((t.endedAt ?? this.openedAt) - (t.startedAt ?? t.createdAt))}`, t.summary, t.meta, "Read-only reporter: live inspection unavailable."].filter(Boolean).join("\n"));
    this.update();
  }
  private run(t: RoutedTask, action: TaskAction): void {
    const generation = ++this.generation; this.stopped = undefined;
    this.mode = "detail"; this.target = t; this.busy = true; this.output = `${action === "stop" ? "Stopping" : "Inspecting"} #${plain(t.taskId)}…`; this.offset = 0; this.update();
    void (async () => {
      try {
        const output = await this.act!(t, action);
        if (!this.disposed && generation === this.generation) { this.output = plain(output); if (action === "stop") this.stopped = identity(t); }
      } catch (error) {
        if (!this.disposed && generation === this.generation) this.output = `Error: ${plain(error instanceof Error ? error.message : String(error))}`;
      } finally {
        if (!this.disposed && generation === this.generation) { this.busy = false; this.update(); }
      }
    })();
  }
  private remove(targets: RoutedTask[]): void {
    const generation = ++this.generation;
    this.stopped = undefined; this.target = undefined; this.busy = true; this.mode = "detail"; this.offset = 0;
    this.output = `Deleting ${targets.length} listed inactive task(s)…`; this.update();
    void (async () => {
      const errors: string[] = []; let deleted = 0;
      for (const target of targets) {
        if (this.disposed || generation !== this.generation) return;
        try {
          const current = this.state().tasks.find(t => identity(t) === identity(target));
          if (!supports(current, "delete") || !this.act) throw new Error("Task action is no longer available");
          await this.act(current!, "delete");
          deleted++;
        } catch (error) {
          errors.push(`#${plain(target.taskId)}: ${plain(error instanceof Error ? error.message : String(error))}`);
        }
        if (this.disposed || generation !== this.generation) return;
        this.output = plain(`${deleted}/${targets.length} deleted${errors.length ? `\nErrors:\n${errors.join("\n")}` : ""}`); this.update();
      }
      if (this.disposed || generation !== this.generation) return;
      this.busy = false;
      // Catalogs, not replies, control membership. Keep partial failures visible.
      if (!errors.length) { this.mode = "list"; this.inactive = true; }
      this.update();
    })();
  }
  handleInput(d: string): void {
    if (this.disposed) return;
    if (matchesKey(d, Key.escape) || matchesKey(d, Key.ctrl("c"))) {
      if (this.mode === "list") this.dismiss();
      else { this.generation++; this.stopped = undefined; this.busy = false; this.mode = "list"; this.offset = 0; this.update(); }
      return;
    }
    if (this.mode === "list" && matchesKey(d, Key.tab)) { this.inactive = !this.inactive; this.state(); this.update(); return; }
    const state = this.state();
    if (this.mode === "clear") {
      if (matchesKey(d, "y")) this.remove(this.batch);
      else if (matchesKey(d, "n")) { this.mode = "list"; this.update(); }
      return;
    }
    if (this.mode === "confirm") {
      if (matchesKey(d, "y")) {
        const current = state.tasks.find(t => this.target && identity(t) === identity(this.target));
        if (current?.phase === "active" && current.actions?.includes("stop") && this.act) this.run(current, "stop");
        else { this.mode = "detail"; this.output = "Error: task is no longer available to stop."; this.update(); }
      } else if (matchesKey(d, "n")) { this.mode = "list"; this.update(); }
      return;
    }
    if (this.busy) return;
    if (matchesKey(d, "r")) {
      if (this.mode === "detail" && this.target) {
        const current = state.tasks.find(t => identity(t) === identity(this.target!));
        if (current) this.inspect(current); else { this.output = "Error: task is no longer available."; this.update(); }
      } else this.update();
      return;
    }
    if (this.mode === "detail" && matchesKey(d, Key.enter)) { this.stopped = undefined; this.mode = "list"; this.offset = 0; this.update(); return; }
    const tasks = this.listed(state);
    const t = this.mode === "list" ? tasks[this.index] : state.tasks.find(t => this.target && identity(t) === identity(this.target));
    if (matchesKey(d, "d") && supports(t, "delete") && this.act) { this.remove([t!]); return; }
    if (this.mode === "list" && this.inactive && matchesKey(d, "x") && this.act) {
      this.batch = tasks.filter(t => supports(t, "delete")).map(t => ({ ...t }));
      if (this.batch.length) { this.mode = "clear"; this.update(); }
      return;
    }
    if (matchesKey(d, "k") && t) {
      if (t.phase === "active" && t.actions?.includes("stop") && this.act) { this.target = t; this.mode = "confirm"; this.update(); }
      return;
    }
    if (this.mode === "list" && matchesKey(d, Key.enter) && t) { this.inspect(t); return; }
    let n = this.mode === "list" ? this.index : this.offset;
    const max = this.mode === "list" ? tasks.length - 1 : this.max;
    if (matchesKey(d, Key.up)) n--; else if (matchesKey(d, Key.down)) n++; else if (matchesKey(d, Key.pageUp)) n -= this.page; else if (matchesKey(d, Key.pageDown)) n += this.page; else if (matchesKey(d, Key.home)) n = 0; else if (matchesKey(d, Key.end)) n = max; else return;
    n = Math.max(0, Math.min(max, n));
    if (this.mode === "list") { this.index = n; this.selected = tasks[n] ? identity(tasks[n]) : undefined; } else this.offset = n;
    this.update();
  }
  render(width: number): string[] {
    if (width <= 0 || this.disposed) return [];
    const state = this.state(), tasks = this.listed(state); this.page = Math.max(1, this.tui.terminal.rows - 7);
    const t = this.mode === "list" ? tasks[this.index] : state.tasks.find(t => this.target && identity(t) === identity(this.target));
    const actionHint = this.act ? `${supports(t, "stop") ? " · k stop" : ""}${supports(t, "delete") ? " · d delete" : ""}` : "";
    let body: string[], hint: string;
    if (this.mode === "clear") {
      body = [`Delete ${this.batch.length} listed inactive task(s)?`, "Read-only and omitted tasks are kept. Unseen history is not cleared."];
      hint = "y delete listed · n/Esc back (no deletion)";
    } else if (this.mode === "confirm") {
      body = [`Stop #${plain(this.target?.taskId ?? "").replace(/\n/g, " ")} (${this.target?.source})?`, "Press y to confirm. This requests termination."];
      hint = "y stop · n/Esc back (no stop)";
    } else if (this.mode === "detail") {
      body = this.output.split("\n").flatMap(line => wrapTextWithAnsi(line, width));
      this.max = Math.max(0, body.length - this.page); this.offset = Math.min(this.offset, this.max); body = body.slice(this.offset, this.offset + this.page);
      hint = this.busy ? "Busy · Esc back (current request continues; queue stops)" : `↑↓ scroll${supports(t, "inspect") && this.act ? " · r inspect again" : ""} · Enter/Esc list${actionHint}`;
    } else {
      const start = Math.max(0, this.index - this.page + 1);
      body = tasks.slice(start, start + this.page).map((t, i) => `${start + i === this.index ? ">" : " "} #${plain(t.taskId).replace(/\n/g, " ")} · ${t.source} · ${plain(t.statusLabel).replace(/\n/g, " ")}${t.actions?.length ? ` [${t.actions.join("/")}]` : " [read-only]"}${t.summary || t.meta ? ` · ${plain(t.summary || t.meta || "").replace(/\n/g, " ")}` : ""}`);
      if (!body.length) body = [`No ${this.inactive ? "inactive" : "active"} tasks.`];
      hint = `Tab active/inactive · ↑↓${t ? " · Enter inspect" : ""}${actionHint}${this.inactive && this.act && tasks.some(t => supports(t, "delete")) ? " · x clear listed" : " · r refresh"} · Esc close`;
    }
    return [this.theme.fg("accent", this.theme.bold(`Tasks · ${this.inactive ? "Inactive" : "Active"} · ${state.activeTotal} active`)), this.theme.fg("borderMuted", "─".repeat(width)), ...body, this.theme.fg("dim", `${state.omitted} omitted · ${tasks.length} listed`), this.theme.fg("dim", hint)].map(line => truncateToWidth(line, width));
  }
  invalidate(): void {}
}

export function registerTaskReporter(pi: ExtensionAPI, reporterSource: TaskSource, options: TaskTimingOptions = {}): TaskReporter {
  const id = randomUUID(), heartbeatMs = options.heartbeatMs ?? 1000, participantStaleMs = options.participantStaleMs ?? 3500, catalogStaleMs = options.catalogStaleMs ?? 3500, now = options.now ?? Date.now;
  let eligible = false, owner = false, command = false, closed = false, mounted = false, sessionId: string | undefined, timer: NodeJS.Timeout | undefined, local: Catalog | undefined, widget: TasksWidget | undefined, tui: TUI | undefined, widgetContext: ExtensionContext | undefined, renderSignature: string | undefined;
  const participants = new Map<string, { sessionId: string; seenAt: number }>(), catalogs = new Map<string, Catalog>();
  const widgetRecords = new Map<string, WidgetRecord>();
  const viewers = new Set<TasksViewer>();
  let generation = 0;
  const pending = new Map<string, { address: ControlAddress; timer: NodeJS.Timeout; resolve: (output: string) => void; reject: (error: Error) => void }>();
  const seenRequests = new Set<string>();
  function emitControl(frame: ControlWire): void {
    try { pi.events.emit(TASKS_CONTROL_CHANNEL, frame); } catch { clearSession(); }
  }
  function requestControl(t: RoutedTask, action: TaskAction): Promise<string> {
    const c = t.participantId ? catalogs.get(t.participantId) : undefined;
    const current = c?.tasks.find(x => x.taskKey === t.taskKey && x.taskId === t.taskId && x.source === t.source);
    if (closed || !eligible || !sessionId || !c || c.sessionId !== sessionId || now() - c.observedAt > catalogStaleMs || !supports(current, action)) return Promise.reject(new Error("Task action is no longer available"));
    const address: ControlAddress = { sessionId, participantId: c.participantId, requesterId: id, taskKey: t.taskKey, taskId: t.taskId, source: t.source, requestId: randomUUID(), action };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(address.requestId); reject(new Error("Task action timed out; its outcome is unknown")); }, Math.max(1, options.controlTimeoutMs ?? 10_000));
      pending.set(address.requestId, { address, timer, resolve, reject });
      emitControl({ v: 1, type: "request", ...address });
    });
  }
  const unsubscribeControl = pi.events.on(TASKS_CONTROL_CHANNEL, raw => {
    const e = controlWire(raw); if (!e || closed || !eligible || e.sessionId !== sessionId) return;
    if (e.type === "reply") {
      const p = pending.get(e.requestId); if (!p || !sameAddress(p.address, e)) return;
      pending.delete(e.requestId); clearTimeout(p.timer);
      if (e.ok) p.resolve(e.output); else p.reject(new Error(e.output));
      return;
    }
    if (e.participantId !== id) return;
    const key = JSON.stringify([e.requesterId, e.requestId]); if (seenRequests.has(key)) return;
    seenRequests.add(key); if (seenRequests.size > 1000) seenRequests.delete(seenRequests.values().next().value!);
    const current = local?.tasks.find(t => t.taskKey === e.taskKey && t.taskId === e.taskId && t.source === e.source);
    const callback = options.controls?.[e.action];
    if (!local || local.sessionId !== sessionId || local.participantId !== id || local.source !== e.source || now() - local.observedAt > catalogStaleMs || !supports(current, e.action) || !callback) {
      emitControl({ ...e, type: "reply", ok: false, output: "Task action is no longer available" }); return;
    }
    const epoch = generation;
    void (async () => {
      let ok = true, output: string;
      try { output = plain(await callback.call(options.controls, e.taskId)); }
      catch (error) { ok = false; output = plain(error instanceof Error ? error.message : String(error)); }
      if (!closed && eligible && generation === epoch && sessionId === e.sessionId) emitControl({ ...e, type: "reply", ok, output });
    })();
  });
  const emit = (e: Wire): boolean => {
    try { pi.events.emit(TASKS_CHANNEL, e); return true; }
    catch { clearSession(); return false; }
  };
  function aggregate(): Aggregate { const n = now(); const best = new Map<string, RoutedTask>(); let omitted = 0, omittedActive = 0; for (const c of catalogs.values()) { if (c.sessionId !== sessionId || n - c.observedAt > catalogStaleMs) continue; omitted += c.omittedActive + c.omittedTerminal; omittedActive += c.omittedActive; for (const t of c.tasks) { const old = best.get(t.taskKey); if (!old || t.updatedAt > old.updatedAt || (t.updatedAt === old.updatedAt && `${t.source}:${t.taskId}` > `${old.source}:${old.taskId}`)) best.set(t.taskKey, { ...t, participantId: c.participantId }); } } const tasks = [...best.values()].sort((a,b) => a.phase === "active" && b.phase !== "active" ? -1 : a.phase !== "active" && b.phase === "active" ? 1 : compare(a,b)); return { tasks, activeTotal: tasks.filter(t => t.phase === "active").length + omittedActive, omitted }; }
  function widgetState(): Aggregate { const n = now(); const current = new Map(aggregate().tasks.map(t => [t.taskKey, t])); for (const task of current.values()) { const record = widgetRecords.get(task.taskKey); const startedAt = task.startedAt ?? task.createdAt; if (task.phase === "active") { if (record) { record.task = task; record.terminalAt = undefined; if (!record.revealed && n - startedAt >= WIDGET_REVEAL_MS) record.revealed = true; } else widgetRecords.set(task.taskKey, { task, revealed: n - startedAt >= WIDGET_REVEAL_MS }); continue; } if (!record) continue; if (!record.revealed) { const endedAt = task.endedAt ?? task.updatedAt; if (endedAt - startedAt < WIDGET_REVEAL_MS) { widgetRecords.delete(task.taskKey); continue; } record.revealed = true; } record.task = task; record.terminalAt ??= n; }
    for (const [taskKey, record] of widgetRecords) { if (record.terminalAt !== undefined) { if (n - record.terminalAt >= WIDGET_LINGER_MS) widgetRecords.delete(taskKey); } else if (!current.has(taskKey)) widgetRecords.delete(taskKey); }
    const tasks = [...widgetRecords.values()].filter(record => record.revealed).map(record => record.task).sort(compare); return { tasks, activeTotal: tasks.filter(task => task.phase === "active").length, omitted: 0 }; }
  function render(): void { for (const viewer of viewers) viewer.update(); if (!owner || !widget || !tui) return; const next = widgetState(); const signature = JSON.stringify(next); if (signature === renderSignature) return; renderSignature = signature; widget.setState(next); tui.requestRender(); }
  function announce(replay = true): void { if (!eligible || !sessionId) return; if (!emit({ v: 1, type: "participant", sessionId, participantId: id, source: reporterSource, seenAt: now() })) return; if (replay && local) emit({ v: 1, type: "catalog", ...local }); }
  const unsubscribe = pi.events.on(TASKS_CHANNEL, raw => { const e = wire(raw); if (!e) return; if (e.type === "probe") { if (owner && eligible && e.sessionId === sessionId) emit({ v: 1, type: "owner", token: e.token, participantId: id }); if (eligible && e.sessionId === sessionId) announce(); return; } if (e.type === "participant") participants.set(e.participantId, { sessionId: e.sessionId, seenAt: now() }); else if (e.type === "leave") { participants.delete(e.participantId); catalogs.delete(e.participantId); } else if (e.type === "catalog") catalogs.set(e.participantId, e); render(); });
  let opening: object | undefined;
  async function openViewer(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") return ctx.ui.notify("/tasks requires interactive mode", "error");
    if (!owner || !eligible || closed || opening || ctx.sessionManager.getSessionId() !== sessionId) return;
    const token = opening = {}; const epoch = generation;
    let viewer: TasksViewer | undefined;
    try { await ctx.ui.custom<void>((viewTui, theme, _keys, done) => {
      viewer = new TasksViewer(aggregate, viewTui, theme, () => { if (opening === token) opening = undefined; done(); }, now(), requestControl);
      if (epoch !== generation || !eligible || closed) viewer.dismiss(); else viewers.add(viewer);
      return viewer;
    }); } finally {
      if (viewer) { viewer.dispose(); viewers.delete(viewer); }
      if (opening === token) opening = undefined;
    }
  }
  pi.on("session_start", (_event, ctx) => {
    if (closed) return;
    if (eligible) shutdown();
    sessionId = ctx.sessionManager.getSessionId(); eligible = true; const token = randomUUID(); let acknowledged = false;
    const off = pi.events.on(TASKS_CHANNEL, raw => { const e = wire(raw); if (e?.type === "owner" && e.token === token) acknowledged = true; }); emit({ v: 1, type: "probe", sessionId, token }); off();
    if (!acknowledged && !owner) { owner = true; emit({ v: 1, type: "owner", token, participantId: id }); }
    if (owner && !command) {
      command = true;
      pi.registerCommand("tasks", { description: "Show all background tasks", handler: async (_args, ctx) => openViewer(ctx) });
      pi.registerShortcut("ctrl+alt+t", { description: "Show background tasks", handler: openViewer });
    }
    if (owner && ctx.mode === "tui") { mounted = true; widgetContext = ctx; ctx.ui.setWidget(TASKS_WIDGET_KEY, (newTui, theme) => { tui = newTui; const initial = widgetState(); renderSignature = JSON.stringify(initial); widget = new TasksWidget(initial, theme); return widget; }, { placement: "aboveEditor" }); }
    announce(); if (heartbeatMs > 0 && !timer) { timer = setInterval(() => { announce(); const n = now(); for (const [key,p] of participants) if (n-p.seenAt > participantStaleMs) { participants.delete(key); catalogs.delete(key); } render(); }, heartbeatMs); timer.unref?.(); }
  });
  function clearSession(ctx?: ExtensionContext): string | undefined {
    const previousSessionId = sessionId;
    generation++; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Task session closed")); } pending.clear(); seenRequests.clear();
    opening = undefined;
    for (const viewer of viewers) viewer.dismiss(); viewers.clear();
    eligible = false; if (timer) clearInterval(timer); timer = undefined; local = undefined; participants.clear(); catalogs.clear(); widgetRecords.clear();
    if (owner && mounted) { try { (ctx ?? widgetContext)?.ui.setWidget(TASKS_WIDGET_KEY, undefined); } catch { /* The captured context may already be stale. */ } }
    mounted = false; widget = undefined; tui = undefined; widgetContext = undefined; renderSignature = undefined; sessionId = undefined;
    return previousSessionId;
  }
  function shutdown(ctx?: ExtensionContext): void { const previousSessionId = clearSession(ctx); if (previousSessionId) emit({ v: 1, type: "leave", sessionId: previousSessionId, participantId: id }); }
  pi.on("session_shutdown", (_event, ctx) => shutdown(ctx));
  return { publishCatalog(sid, input) { if (closed || !sessionId || sid !== sessionId) return; const normalized = input.flatMap(v => { const t = task(v, reporterSource); if (!t) return []; delete t.actions; if (options.controls) t.actions = ["inspect", ...(t.phase === "active" && options.controls.stop ? ["stop" as const] : []), ...(t.phase !== "active" && options.controls.delete ? ["delete" as const] : [])]; return [t]; }); const active = normalized.filter(t => t.phase === "active").sort(compare); const terminal = normalized.filter(t => t.phase !== "active").sort((a,b) => b.updatedAt-a.updatedAt || compare(a,b)); const kept = [...active.slice(0,CAP), ...terminal.slice(0, Math.max(0,CAP-active.length))]; local = { sessionId, participantId: id, source: reporterSource, observedAt: now(), tasks: kept, omittedActive: Math.max(0,active.length-CAP), omittedTerminal: Math.max(0, terminal.length-Math.max(0,CAP-active.length)) }; emit({ v: 1, type: "catalog", ...local }); }, close() { if (closed) return; closed = true; shutdown(); unsubscribe(); unsubscribeControl(); } };
}
