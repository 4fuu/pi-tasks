import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { registerTaskReporter, TASKS_CHANNEL, TASKS_CONTROL_CHANNEL, TASKS_WIDGET_KEY, TasksViewer, type PresentedTask } from "../src/index.js";

type Handler = (event: unknown, context: ExtensionContext) => void | Promise<void>;
class Bus {
  emitter = new EventEmitter();
  emit(channel: string, data: unknown): void { this.emitter.emit(channel, data); }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const safe = async (data: unknown) => { try { await handler(data); } catch { /* production bus isolates handlers */ } };
    this.emitter.on(channel, safe); return () => this.emitter.off(channel, safe);
  }
}
function fake(bus: Bus, session = "s") {
  const handlers = new Map<string, Handler[]>(), commands: string[] = [], widgets: Array<[string, unknown]> = [];
  let stale = false, eventEmits = 0;
  let commandHandler: (args: string, ctx: ExtensionContext) => Promise<void>;
  let viewer: TasksViewer | undefined;
  let renders = 0;
  const tui = { terminal: { rows: 24 }, requestRender: () => { renders++; } };
  let component: { render(width: number): string[] } | undefined;
  const ui = {
    setWidget: (key: string, value: unknown) => {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      widgets.push([key, value]);
      if (typeof value === "function") component = value(tui, theme);
    },
    notify: () => undefined,
    custom: (factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => TasksViewer) => new Promise<void>(resolve => { viewer = factory(tui as TUI, theme as Theme, {}, resolve); }),
  };
  const theme = { fg: (_tone: string, value: string) => value, bold: (value: string) => value };
  const api = {
    events: {
      emit: (channel: string, data: unknown) => {
        eventEmits++;
        if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
        bus.emit(channel, data);
      },
      on: bus.on.bind(bus),
    },
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (name: string, definition: { handler: typeof commandHandler }) => { commands.push(name); commandHandler = definition.handler; },
  } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => session }, ui } as unknown as ExtensionContext;
  return {
    api, commands, widgets,
    get viewer() { return viewer!; },
    open() { return commandHandler("", ctx); },
    get component() { return component; },
    get renders() { return renders; },
    get eventEmits() { return eventEmits; },
    invalidate() { stale = true; },
    async fire(name: string) { for (const h of handlers.get(name) ?? []) await h({}, ctx); },
  };
}
const active = (key: string, source: PresentedTask["source"]): PresentedTask => ({ taskKey: key, source, taskId: key, phase: "active", statusLabel: "running", createdAt: 1, updatedAt: 2 });

test("all load orders elect one owner, command, and stable widget", async () => {
  for (const order of [["python", "pwsh", "subagent"], ["subagent", "python", "pwsh"]] as const) {
    const bus = new Bus(); const extensions = order.map(source => fake(bus));
    const reporters = extensions.map((x, i) => registerTaskReporter(x.api, order[i], { heartbeatMs: 60_000 }));
    for (const x of extensions) await x.fire("session_start");
    assert.equal(extensions.flatMap(x => x.commands).filter(x => x === "tasks").length, 1);
    assert.equal(extensions.flatMap(x => x.widgets).filter(([k,v]) => k === TASKS_WIDGET_KEY && v).length, 1);
    reporters.forEach(x => x.close());
  }
});

test("never-started ghost cannot acknowledge or block owner", async () => {
  const bus = new Bus(), ghost = fake(bus), real = fake(bus);
  const a = registerTaskReporter(ghost.api, "python", { heartbeatMs: 60_000 });
  const b = registerTaskReporter(real.api, "pwsh", { heartbeatMs: 60_000 });
  await real.fire("session_start"); assert.deepEqual(real.commands, ["tasks"]); a.close(); b.close();
});

test("late mismatched publish is ignored and updates do not remount", async () => {
  const bus = new Bus(), x = fake(bus); const reporter = registerTaskReporter(x.api, "python", { heartbeatMs: 60_000 });
  await x.fire("session_start"); const mounted = x.widgets.length;
  assert.deepEqual(x.component?.render(60), []);
  reporter.publishCatalog("old", [active("bad", "python")]);
  reporter.publishCatalog("s", [active("good", "python")]);
  assert.match(x.component?.render(60)[0] ?? "", /^Tasks · 1 active/);
  reporter.publishCatalog("s", []);
  assert.deepEqual(x.component?.render(60), []);
  assert.equal(x.widgets.length, mounted); assert.ok(x.renders >= 2); reporter.close();
});

test("the widget reveals long tasks after five seconds and lingers terminal state for five seconds", async () => {
  let now = 1_000;
  const bus = new Bus(), x = fake(bus); const reporter = registerTaskReporter(x.api, "python", { heartbeatMs: 0, now: () => now });
  await x.fire("session_start"); const mounted = x.widgets.length;
  const running: PresentedTask = { taskKey: "python:slow", source: "python", taskId: "slow", phase: "active", statusLabel: "running", createdAt: now, updatedAt: now };
  reporter.publishCatalog("s", [running]);
  assert.deepEqual(x.component?.render(60), []);
  now += 4_999; reporter.publishCatalog("s", [running]);
  assert.deepEqual(x.component?.render(60), []);
  now += 1; reporter.publishCatalog("s", [running]);
  assert.match(x.component?.render(60)[0] ?? "", /^Tasks · 1 active/);

  now += 100;
  const completed: PresentedTask = { ...running, phase: "completed", statusLabel: "completed", updatedAt: now, endedAt: now };
  reporter.publishCatalog("s", [completed]);
  assert.match(x.component?.render(60).join("\n") ?? "", /Tasks · 0 active[\s\S]*completed/);
  now += 4_999; reporter.publishCatalog("s", []);
  assert.match(x.component?.render(60).join("\n") ?? "", /completed/);
  now += 1; reporter.publishCatalog("s", []);
  assert.deepEqual(x.component?.render(60), []);
  assert.equal(x.widgets.length, mounted);
  reporter.close();
});

test("tasks that finish within five seconds never flash in the widget", async () => {
  let now = 1_000;
  const bus = new Bus(), x = fake(bus); const reporter = registerTaskReporter(x.api, "python", { heartbeatMs: 0, now: () => now });
  await x.fire("session_start");
  const running: PresentedTask = { taskKey: "python:fast", source: "python", taskId: "fast", phase: "active", statusLabel: "running", createdAt: now, updatedAt: now };
  reporter.publishCatalog("s", [running]);
  now += 4_000;
  reporter.publishCatalog("s", [{ ...running, phase: "completed", statusLabel: "completed", updatedAt: now, endedAt: now }]);
  assert.deepEqual(x.component?.render(60), []);
  reporter.close();
});

test("a shutdown owner does not block the next live session", async () => {
  const bus = new Bus(), first = fake(bus, "one"), second = fake(bus, "two");
  const a = registerTaskReporter(first.api, "python", { heartbeatMs: 60_000 });
  const b = registerTaskReporter(second.api, "pwsh", { heartbeatMs: 60_000 });
  await first.fire("session_start");
  await first.fire("session_shutdown");
  await second.fire("session_start");
  assert.deepEqual(second.commands, ["tasks"]);
  a.close(); b.close();
});

test("a stale heartbeat context is contained and stops the reporter", async () => {
  const bus = new Bus(), x = fake(bus);
  const reporter = registerTaskReporter(x.api, "pwsh", { heartbeatMs: 5 });
  try {
    await x.fire("session_start");
    const before = x.eventEmits;
    x.invalidate();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(x.eventEmits, before + 1);
  } finally {
    reporter.close();
  }
});

test("malformed and oversized bus payloads are harmless", () => {
  const bus = new Bus(), x = fake(bus); const r = registerTaskReporter(x.api, "python");
  bus.emit(TASKS_CHANNEL, null); bus.emit(TASKS_CHANNEL, { v: 1, type: "catalog", sessionId: "s", tasks: new Array(1000).fill(null) }); r.close();
});

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const screen = (x: ReturnType<typeof fake>, width = 120) => x.viewer.render(width).join("\n");

test("independent package roots route plain controls to the originating catalog only", async () => {
  const { mkdtemp, copyFile, rm } = await import("node:fs/promises");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const root = await mkdtemp(fileURLToPath(new URL("../.control-test-", import.meta.url)));
  const bus = new Bus(), a = fake(bus), b = fake(bus), c = fake(bus);
  const calls: string[] = [], frames: unknown[] = [];
  bus.on(TASKS_CONTROL_CHANNEL, e => frames.push(e));
  const r1 = registerTaskReporter(a.api, "python", { heartbeatMs: 0, controls: { inspect: async id => { calls.push(`python:${id}`); return "wrong"; } } });
  let r2: ReturnType<typeof registerTaskReporter> | undefined, r3: ReturnType<typeof registerTaskReporter> | undefined;
  try {
    await copyFile(new URL("../src/index.ts", import.meta.url), `${root}/index.ts`);
    const other = await import(pathToFileURL(`${root}/index.ts`).href) as typeof import("../src/index.js");
    assert.notEqual(other.registerTaskReporter, registerTaskReporter);
    r2 = other.registerTaskReporter(b.api, "pwsh", { heartbeatMs: 0, controls: { inspect: async id => { calls.push(`pwsh:${id}`); return "remote output"; }, stop: async id => { calls.push(`stop:${id}`); return "stopped"; } } });
    r3 = other.registerTaskReporter(c.api, "pwsh", { heartbeatMs: 0, controls: { inspect: async () => { calls.push("wrong catalog"); return "wrong"; } } });
    await a.fire("session_start"); await b.fire("session_start"); await c.fire("session_start");
    r1.publishCatalog("s", [active("same", "python")]);
    r2.publishCatalog("s", [{ ...active("same", "pwsh"), updatedAt: 3 }]);
    r3.publishCatalog("s", [{ ...active("same", "pwsh"), updatedAt: 1 }]);
    const opened = a.open(); a.viewer.render(120); a.viewer.handleInput("\r"); await settle();
    assert.match(screen(a), /remote output/); assert.deepEqual(calls, ["pwsh:same"]);
    a.viewer.handleInput("\x1b"); a.viewer.handleInput("k");
    assert.match(screen(a), /Press y to confirm/); assert.equal(calls.length, 1);
    a.viewer.handleInput("y"); await settle(); assert.deepEqual(calls, ["pwsh:same", "stop:same"]);
    assert.equal(frames.length, 4);
    for (const frame of frames) assert.deepEqual(JSON.parse(JSON.stringify(frame)), frame);
    a.viewer.handleInput("\x1b"); a.viewer.handleInput("\x1b"); await opened;
  } finally { r1.close(); r2?.close(); r3?.close(); await rm(root, { recursive: true, force: true }); }
});

test("older read-only catalogs remain inspectable without emitting controls", async () => {
  const bus = new Bus(), x = fake(bus), frames: unknown[] = [];
  bus.on(TASKS_CONTROL_CHANNEL, e => frames.push(e));
  const r = registerTaskReporter(x.api, "python", { heartbeatMs: 0 });
  try {
    await x.fire("session_start");
    bus.emit(TASKS_CHANNEL, { v: 1, type: "catalog", sessionId: "s", participantId: "old-root", source: "pwsh", observedAt: Date.now(), tasks: [{ ...active("legacy", "pwsh"), summary: "catalog summary" }] });
    const opened = x.open(); x.viewer.render(100); x.viewer.handleInput("k"); x.viewer.handleInput("y"); x.viewer.handleInput("\r");
    assert.match(screen(x), /catalog summary/); assert.match(screen(x), /Read-only/);
    x.viewer.handleInput("r"); assert.equal(frames.length, 0);
    x.viewer.handleInput("\x1b"); x.viewer.handleInput("\x1b"); await opened;
  } finally { r.close(); }
});

test("control recipient validates session, catalog, task, source, capability and active phase", async () => {
  const bus = new Bus(), x = fake(bus); let participantId = "", calls = 0, now = 10;
  const replies: Record<string, unknown>[] = [];
  bus.on(TASKS_CHANNEL, raw => { const e = raw as Record<string, unknown>; if (e.type === "catalog") participantId = e.participantId as string; });
  bus.on(TASKS_CONTROL_CHANNEL, raw => { const e = raw as Record<string, unknown>; if (e.type === "reply") replies.push(e); });
  const r = registerTaskReporter(x.api, "pwsh", { heartbeatMs: 0, now: () => now, controls: { inspect: async () => { calls++; throw new Error("callback failed"); }, stop: async () => { calls++; return "stopped"; } } });
  try {
    await x.fire("session_start"); r.publishCatalog("s", [active("t", "pwsh")]);
    const base = { v: 1, type: "request", sessionId: "s", participantId, requesterId: "remote", taskKey: "t", taskId: "t", source: "pwsh", requestId: "one", action: "stop" };
    for (const patch of [{ sessionId: "wrong" }, { participantId: "wrong" }, { taskKey: "wrong" }, { taskId: "wrong" }, { source: "python" }, { action: "destroy" }]) bus.emit(TASKS_CONTROL_CHANNEL, { ...base, ...patch, requestId: JSON.stringify(patch) });
    await settle(); assert.equal(calls, 0); assert.equal(replies.length, 3);
    r.publishCatalog("s", [{ ...active("t", "pwsh"), phase: "completed" }]);
    bus.emit(TASKS_CONTROL_CHANNEL, { ...base, requestId: "terminal" }); await settle(); assert.equal(calls, 0);
    bus.emit(TASKS_CONTROL_CHANNEL, { ...base, requestId: "inspect", action: "inspect" }); await settle();
    assert.equal(calls, 1); assert.equal(replies.at(-1)?.ok, false); assert.equal(replies.at(-1)?.output, "callback failed");
    now = 4000; bus.emit(TASKS_CONTROL_CHANNEL, { ...base, requestId: "stale", action: "inspect" }); await settle(); assert.equal(calls, 1);
    r.publishCatalog("s", []); bus.emit(TASKS_CONTROL_CHANNEL, { ...base, requestId: "gone", action: "inspect" }); await settle(); assert.equal(calls, 1);
  } finally { r.close(); }
});

test("wrong replies cannot resolve a pending request; timeout ignores late replies", async () => {
  const bus = new Bus(), x = fake(bus); let request: Record<string, unknown> | undefined;
  bus.on(TASKS_CONTROL_CHANNEL, raw => { const e = raw as Record<string, unknown>; if (e.type === "request") request = e; });
  const r = registerTaskReporter(x.api, "python", { heartbeatMs: 0, controlTimeoutMs: 20 });
  try {
    await x.fire("session_start");
    bus.emit(TASKS_CHANNEL, { v: 1, type: "catalog", sessionId: "s", participantId: "remote", source: "pwsh", observedAt: Date.now(), tasks: [{ ...active("t", "pwsh"), actions: ["inspect"] }] });
    const opened = x.open(); x.viewer.render(120); x.viewer.handleInput("\r"); assert.ok(request);
    for (const patch of [{ sessionId: "wrong" }, { taskId: "wrong" }, { taskKey: "wrong" }, { participantId: "wrong" }, { requesterId: "wrong" }, { requestId: "wrong" }, { source: "python" }, { action: "stop" }]) bus.emit(TASKS_CONTROL_CHANNEL, { ...request, type: "reply", ok: true, output: "FORGED", ...patch });
    await settle(); assert.match(screen(x), /Inspecting/);
    await new Promise(resolve => setTimeout(resolve, 35)); assert.match(screen(x), /timed out/);
    const renders = x.renders;
    bus.emit(TASKS_CONTROL_CHANNEL, { ...request, type: "reply", ok: true, output: "LATE" }); await settle();
    assert.equal(x.renders, renders); assert.doesNotMatch(screen(x), /LATE|FORGED/);
    x.viewer.handleInput("\x1b"); x.viewer.handleInput("\x1b"); await opened;
  } finally { r.close(); }
});

test("session shutdown and close discard in-flight results and pending UI updates", async () => {
  for (const shutdown of [true, false]) {
    const bus = new Bus(), a = fake(bus), b = fake(bus); let resolve!: (s: string) => void;
    const frames: Record<string, unknown>[] = [];
    bus.on(TASKS_CONTROL_CHANNEL, raw => frames.push(raw as Record<string, unknown>));
    const r1 = registerTaskReporter(a.api, "python", { heartbeatMs: 0, controlTimeoutMs: 20 });
    const r2 = registerTaskReporter(b.api, "pwsh", { heartbeatMs: 0, controls: { inspect: () => new Promise(r => { resolve = r; }) } });
    try {
      await a.fire("session_start"); await b.fire("session_start"); r2.publishCatalog("s", [active("pending", "pwsh")]);
      void a.open(); a.viewer.render(100); a.viewer.handleInput("\r"); assert.equal(frames.length, 1);
      if (shutdown) { await a.fire("session_shutdown"); await b.fire("session_shutdown"); } else { r1.close(); r2.close(); }
      const renders = a.renders; resolve("late callback"); await new Promise(r => setTimeout(r, 35));
      assert.equal(frames.length, 1); assert.equal(a.renders, renders); assert.deepEqual(a.viewer.render(100), []);
      bus.emit(TASKS_CONTROL_CHANNEL, { ...frames[0], type: "reply", ok: true, output: "late reply" }); await settle(); assert.equal(a.renders, renders);
    } finally { r1.close(); r2.close(); }
  }
});

test("viewer preserves selection, requires explicit stop confirmation and bounds every width", async () => {
  const theme = { fg: (_tone: string, s: string) => s, bold: (s: string) => s } as Theme;
  let tasks: PresentedTask[] = Array.from({ length: 30 }, (_, i) => ({ ...active(String(i), "pwsh"), actions: ["inspect", "stop"] }));
  let calls = 0, renders = 0, closed = 0, resolve!: (s: string) => void;
  const viewer = new TasksViewer(() => ({ tasks, activeTotal: tasks.length, omitted: 0 }), { terminal: { rows: 12 }, requestRender: () => renders++ } as unknown as TUI, theme, () => closed++, 10, async () => { calls++; return new Promise(r => { resolve = r; }); });
  viewer.render(120); viewer.handleInput("\x1b[B");
  tasks = [active("new", "python"), ...tasks]; assert.match(viewer.render(120).join("\n"), /> #1 /);
  viewer.handleInput("\x1b[6~"); assert.match(viewer.render(120).join("\n"), /> #6 /);
  viewer.handleInput("\x1b[F"); assert.match(viewer.render(120).join("\n"), /> #29 /);
  viewer.handleInput("\x1b[H"); assert.match(viewer.render(120).join("\n"), /> #new /);
  viewer.handleInput("\x1b[B"); viewer.handleInput("k"); viewer.handleInput("\r"); assert.equal(calls, 0);
  viewer.handleInput("\x1b"); viewer.handleInput("y"); assert.equal(calls, 0); assert.equal(closed, 0);
  viewer.handleInput("k");
  for (const width of [0, 1, 2, 8, 20, 80]) for (const line of viewer.render(width)) assert.ok(visibleWidth(line) <= width);
  viewer.handleInput("y"); assert.equal(calls, 1); assert.match(viewer.render(120).join("\n"), /Busy/);
  resolve("\x1b]52;c;EVIL\x07\x1b[31m界\x00\u202e" + "x".repeat(20_000)); await settle();
  for (const width of [0, 1, 2, 8, 20, 80]) for (const line of viewer.render(width)) { assert.ok(visibleWidth(line) <= width); assert.doesNotMatch(line.replace(/\x1b\[0m/g, ""), /[\x00-\x1f\u202e]|EVIL/); }
  viewer.handleInput("r"); assert.equal(calls, 2); viewer.handleInput("\x1b"); const before = renders; resolve("ignored"); await settle(); assert.equal(renders, before);
  assert.doesNotMatch(viewer.render(120).join("\n"), /ignored/);
  viewer.handleInput("\r"); viewer.dispose(); const disposedRenders = renders; resolve("disposed"); await settle(); assert.equal(renders, disposedRenders);
});

test("terminal transition during confirmation cannot stop a different or completed task", async () => {
  const theme = { fg: (_tone: string, s: string) => s, bold: (s: string) => s } as Theme;
  const t: PresentedTask = { ...active("t", "pwsh"), actions: ["inspect", "stop"] };
  let tasks = [t], calls = 0;
  const viewer = new TasksViewer(() => ({ tasks, activeTotal: 1, omitted: 0 }), { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme, () => {}, 10, async () => { calls++; return "bad"; });
  viewer.render(100); viewer.handleInput("k"); tasks = [{ ...t, phase: "completed" }]; viewer.handleInput("y");
  assert.equal(calls, 0); assert.match(viewer.render(100).join("\n"), /no longer available/); viewer.dispose();
});

test("published actions come from callbacks, and replies are bounded plain text", async () => {
  const bus = new Bus(), x = fake(bus); let catalog: { participantId: string; tasks: PresentedTask[] } | undefined;
  const replies: Array<{ output: string; ok: boolean }> = [];
  bus.on(TASKS_CHANNEL, raw => { const e = raw as { type: string; participantId: string; tasks: PresentedTask[] }; if (e.type === "catalog") catalog = e; });
  bus.on(TASKS_CONTROL_CHANNEL, raw => { const e = raw as { type: string; output: string; ok: boolean }; if (e.type === "reply") replies.push(e); });
  const readOnly = registerTaskReporter(x.api, "pwsh", { heartbeatMs: 0 });
  await x.fire("session_start"); readOnly.publishCatalog("s", [{ ...active("t", "pwsh"), actions: ["inspect", "stop"] }]);
  assert.equal(catalog!.tasks[0].actions, undefined); readOnly.close();
  const y = fake(bus); let calls = 0;
  const r = registerTaskReporter(y.api, "pwsh", { heartbeatMs: 0, controls: { inspect: async () => { calls++; return "\x1b]52;c;secret\x07\x1b[2J\u202e" + "x".repeat(30_000); }, stop: async () => "stopped" } });
  try {
    await y.fire("session_start"); r.publishCatalog("s", [active("t", "pwsh"), { ...active("done", "pwsh"), phase: "completed" }]);
    assert.deepEqual(catalog!.tasks[0].actions, ["inspect", "stop"]); assert.deepEqual(catalog!.tasks[1].actions, ["inspect"]);
    const request = { v: 1, type: "request", sessionId: "s", participantId: catalog!.participantId, requesterId: "remote", taskKey: "t", taskId: "t", source: "pwsh", requestId: "once", action: "inspect" };
    bus.emit(TASKS_CONTROL_CHANNEL, request); bus.emit(TASKS_CONTROL_CHANNEL, request); await settle();
    assert.equal(calls, 1); assert.equal(replies.length, 1); assert.ok(replies[0].output.length <= 16_000);
    assert.doesNotMatch(replies[0].output, /secret|[\x00-\x1f\u202e]/);
    assert.match(replies[0].output, /output truncated/);
  } finally { r.close(); }
});


test("viewer defaults to active tasks, toggles history and clamps filtered selection", async () => {
  const x = fake(new Bus()), r = registerTaskReporter(x.api, "pwsh", { heartbeatMs: 0 });
  try {
    await x.fire("session_start");
    const done: PresentedTask = { ...active("done", "pwsh"), phase: "completed" };
    r.publishCatalog("s", [active("a", "pwsh"), active("b", "pwsh"), done]);
    void x.open();
    assert.match(screen(x, 32), /Tasks · Active/); assert.match(screen(x, 32), /Tab active\/inactive/);
    assert.doesNotMatch(screen(x), /#done/);
    x.viewer.handleInput("\x1b[F"); assert.match(screen(x), /> #b /);
    x.viewer.handleInput("\t"); assert.match(screen(x), /Tasks · Inactive/); assert.match(screen(x), /> #done /);
    assert.doesNotMatch(screen(x), /#[ab] /);
    x.viewer.handleInput("\t"); assert.match(screen(x), /> #a /);
    r.publishCatalog("s", [done]); assert.match(screen(x), /No active tasks/);
    x.viewer.handleInput("\t"); assert.match(screen(x), /> #done /);
    x.viewer.handleInput("\x1b");
    void x.open(); assert.match(screen(x), /No active tasks/);
    x.viewer.handleInput("\t"); assert.match(screen(x), /#done/);
  } finally { r.close(); }
});

test("natural completion retains inspection and history with refresh against the full catalog", async () => {
  const x = fake(new Bus()); let calls = 0;
  const r = registerTaskReporter(x.api, "pwsh", { heartbeatMs: 0, controls: { inspect: async () => `inspection ${++calls}` } });
  try {
    await x.fire("session_start"); r.publishCatalog("s", [active("t", "pwsh")]);
    void x.open(); x.viewer.handleInput("\r"); await settle();
    r.publishCatalog("s", [{ ...active("t", "pwsh"), phase: "completed" }]);
    assert.match(screen(x), /inspection 1/);
    x.viewer.handleInput("r"); await settle(); assert.match(screen(x), /inspection 2/);
    x.viewer.handleInput("\r"); assert.match(screen(x), /No active tasks/);
    x.viewer.handleInput("\t"); r.publishCatalog("s", [{ ...active("t", "pwsh"), phase: "completed" }]);
    assert.match(screen(x), /Inactive/); assert.match(screen(x), /#t /);
    x.viewer.handleInput("\r"); await settle(); assert.match(screen(x), /inspection 3/);
  } finally { r.close(); }
});

test("successful confirmed stop returns to active tasks or closes after the last active task", async () => {
  for (const otherActive of [true, false]) {
    const x = fake(new Bus()); const remaining = otherActive ? [active("other", "pwsh")] : [];
    const stopped: PresentedTask = { ...active("target", "pwsh"), phase: "cancelled", statusLabel: "stopped" };
    const r = registerTaskReporter(x.api, "pwsh", { heartbeatMs: 0, controls: {
      inspect: async () => "inspect", stop: async () => { r.publishCatalog("s", [...remaining, stopped]); return "stopped"; },
    } });
    try {
      await x.fire("session_start"); r.publishCatalog("s", [active("target", "pwsh"), ...remaining]);
      void x.open(); x.viewer.handleInput("\x1b[F"); x.viewer.handleInput("k"); x.viewer.handleInput("y"); await settle();
      if (otherActive) {
        assert.match(screen(x), /Active/); assert.match(screen(x), /> #other /); assert.doesNotMatch(screen(x), /#target/);
        x.viewer.handleInput("\t"); assert.match(screen(x), /#target/);
      } else assert.equal(screen(x), "");
    } finally { r.close(); }
  }
});

test("stop waits for both reply and terminal catalog, including delayed catalogs and omitted active tasks", async () => {
  for (const omittedActive of [0, 1]) {
    let now = 10; const bus = new Bus(), x = fake(bus); let request: Record<string, unknown> | undefined;
    bus.on(TASKS_CONTROL_CHANNEL, raw => { const e = raw as Record<string, unknown>; if (e.type === "request") request = e; });
    const r = registerTaskReporter(x.api, "python", { heartbeatMs: 0, now: () => now });
    const publish = (tasks: PresentedTask[], observedAt = now) => bus.emit(TASKS_CHANNEL, { v: 1, type: "catalog", sessionId: "s", participantId: "remote", source: "pwsh", observedAt, tasks, omittedActive });
    const t: PresentedTask = { ...active("t", "pwsh"), actions: ["inspect", "stop"] };
    try {
      await x.fire("session_start"); publish([t]); void x.open(); x.viewer.handleInput("k"); x.viewer.handleInput("y");
      assert.match(screen(x), /Stopping/);
      bus.emit(TASKS_CONTROL_CHANNEL, { ...request, type: "reply", ok: true, output: "accepted" }); await settle();
      assert.match(screen(x), /accepted/); // An active catalog is not proof of termination.
      publish([]); assert.match(screen(x), /accepted/); // Neither is a missing task.
      now = 4000; publish([{ ...t, phase: "cancelled" }], 10); assert.match(screen(x), /accepted/);
      publish([{ ...t, phase: "cancelled" }]);
      if (omittedActive) { assert.match(screen(x), /Active · 1 active/); assert.match(screen(x), /No active tasks/); }
      else assert.equal(screen(x), "");
    } finally { r.close(); }
  }
});

test("rejected or timed-out stops stay open even after a terminal catalog arrives", async () => {
  for (const reject of [true, false]) {
    const bus = new Bus(), x = fake(bus); let request: Record<string, unknown> | undefined;
    bus.on(TASKS_CONTROL_CHANNEL, raw => { const e = raw as Record<string, unknown>; if (e.type === "request") request = e; });
    const r = registerTaskReporter(x.api, "python", { heartbeatMs: 0, controlTimeoutMs: 20 });
    const publish = (phase: PresentedTask["phase"]) => bus.emit(TASKS_CHANNEL, { v: 1, type: "catalog", sessionId: "s", participantId: "remote", source: "pwsh", observedAt: Date.now(), tasks: [{ ...active("t", "pwsh"), phase, actions: ["inspect", "stop"] }] });
    try {
      await x.fire("session_start"); publish("active"); void x.open(); x.viewer.handleInput("k"); x.viewer.handleInput("y");
      publish("cancelled"); assert.match(screen(x), /Stopping/);
      if (reject) bus.emit(TASKS_CONTROL_CHANNEL, { ...request, type: "reply", ok: false, output: "denied" });
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.match(screen(x), reject ? /Error: denied/ : /outcome is unknown/);
      bus.emit(TASKS_CONTROL_CHANNEL, { ...request, type: "reply", ok: true, output: "late" }); await settle();
      publish("cancelled"); assert.match(screen(x), /Error:/);
    } finally { r.close(); }
  }
});

test("Escape during a stop or while awaiting its catalog prevents later UI transitions", async () => {
  for (const escapeBeforeReply of [true, false]) {
    const x = fake(new Bus()); let resolve!: (output: string) => void;
    const r = registerTaskReporter(x.api, "pwsh", { heartbeatMs: 0, controls: { inspect: async () => "inspect", stop: () => new Promise(r => { resolve = r; }) } });
    try {
      await x.fire("session_start"); r.publishCatalog("s", [active("t", "pwsh")]);
      void x.open(); x.viewer.handleInput("k"); x.viewer.handleInput("y");
      if (escapeBeforeReply) x.viewer.handleInput("\x1b");
      resolve("stopped"); await settle();
      if (!escapeBeforeReply) x.viewer.handleInput("\x1b");
      x.viewer.handleInput("\t");
      r.publishCatalog("s", [{ ...active("t", "pwsh"), phase: "cancelled" }]); await settle();
      assert.match(screen(x), /Inactive/); assert.match(screen(x), /#t /);
    } finally { r.close(); }
  }
});
