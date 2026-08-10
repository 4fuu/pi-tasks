import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTaskReporter, TASKS_CHANNEL, TASKS_WIDGET_KEY, type PresentedTask } from "../src/index.js";

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
  let renders = 0;
  const tui = { terminal: { rows: 24 }, requestRender: () => { renders++; } };
  let component: { render(width: number): string[] } | undefined;
  const ui = {
    setWidget: (key: string, value: unknown) => { widgets.push([key, value]); if (typeof value === "function") component = value(tui, theme); },
    notify: () => undefined, custom: async () => undefined,
  };
  const theme = { fg: (_tone: string, value: string) => value, bold: (value: string) => value };
  const api = {
    events: { emit: bus.emit.bind(bus), on: bus.on.bind(bus) },
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (name: string) => commands.push(name),
  } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => session }, ui } as unknown as ExtensionContext;
  return { api, commands, widgets, get component() { return component; }, get renders() { return renders; }, async fire(name: string) { for (const h of handlers.get(name) ?? []) await h({}, ctx); } };
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

test("malformed and oversized bus payloads are harmless", () => {
  const bus = new Bus(), x = fake(bus); const r = registerTaskReporter(x.api, "python");
  bus.emit(TASKS_CHANNEL, null); bus.emit(TASKS_CHANNEL, { v: 1, type: "catalog", sessionId: "s", tasks: new Array(1000).fill(null) }); r.close();
});
