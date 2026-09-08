# @4fu/pi-tasks

Dependency-only shared task presentation runtime for Pi extensions. Source
plugins call `registerTaskReporter(pi, source)` and publish their current
catalog. Instances loaded from separate dependency roots coordinate exclusively
through the stable `@4fu/pi-tasks/v1` `pi.events` channel. A synchronous probe
elects one presentation owner, which alone registers `/tasks` and owns the
stable above-editor widget.

## Usage

```ts
import { registerTaskReporter } from "@4fu/pi-tasks";
const tasks = registerTaskReporter(pi, "python");
tasks.publishCatalog(sessionId, currentTasks);
```

The package is installed transitively by task source plugins; users normally do
not install or configure it directly. Run `/tasks` in interactive mode for a
live catalog containing active and recent terminal tasks. Select with arrow
keys, then press Enter to inspect, `r` to refresh, or `k` followed by `y` to
stop a task that supports it. Escape returns or cancels confirmation without
stopping anything. Reporters without controls remain read-only. The compact
widget suppresses short-lived work: a task appears only after running for five
seconds, then remains visible in its terminal state for at least five seconds
before leaving the panel.

All task plugins must be upgraded together when migrating from older task
packages. Mixed generations cannot coordinate their legacy widgets/commands with
this channel.

## Optional task controls

```ts
const tasks = registerTaskReporter(pi, "pwsh", {
  controls: {
    inspect: async (taskId) => inspectOwnedTask(taskId),
    stop: async (taskId) => stopOwnedTask(taskId), // optional
  },
});
```

Callbacks return plain-text output. The source remains responsible for task
ownership and process lifecycle. The UI advertises stop only for active tasks,
and requires confirmation before a request. Output is sanitized and capped at
16,000 characters with an explicit truncation notice. Put full-log paths before
large output when the source has them.

Control requests and replies use `@4fu/pi-tasks/control/v1`, with session,
participant, task, and request identities. Requests time out after ten seconds;
`controlTimeoutMs` overrides that limit. A timeout means the outcome is unknown,
not that the operation was cancelled. Escape while a request is in flight leaves
that request running. Late replies cannot update a closed view or another
session.

Catalog-only v1 reporters remain compatible. For the interactive UI, update
every copy that might become the presentation owner. An older owner still shows
its read-only viewer, even when another source supports controls.

## Development

Requires Node 22.19 or newer. Run `npm install --ignore-scripts`, `npm test`,
and `npm pack --dry-run`.
