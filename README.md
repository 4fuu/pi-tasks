# @4fu/pi-tasks

Dependency-only shared task presentation runtime for Pi extensions. Source
plugins call `registerTaskReporter(pi, source)` and publish their current
catalog. Instances loaded from separate dependency roots coordinate exclusively
through the stable `@4fu/pi-tasks/v1` `pi.events` channel. A synchronous probe
elects one presentation owner, which alone registers `/tasks` and Ctrl+Alt+T and
owns the stable above-editor widget. Both entry points open the same viewer;
repeated shortcuts cannot open duplicate viewers.

## Usage

```ts
import { registerTaskReporter } from "@4fu/pi-tasks";
const tasks = registerTaskReporter(pi, "python");
tasks.publishCatalog(sessionId, currentTasks);
```

The package is installed transitively by task source plugins; users normally do
not install or configure it directly. Run `/tasks` or press Ctrl+Alt+T in
interactive mode for the live Active list. Press Tab to switch between Active
tasks and Inactive history (completed, failed, or cancelled tasks). An empty
Active list stays open so Tab can reach history. Select with arrow keys, then
press Enter to inspect, `r` to refresh, or `k` followed by `y` to stop a task
that supports it. Hints show only actions supported by the selected task;
Inactive tasks never offer stop. Reporters without controls remain read-only.

In Inactive, `d` deletes the selected task without confirmation when its source
supports deletion. After success, the viewer returns to Inactive and stays open
even if empty. Catalog updates determine which tasks remain listed; a reply
never hides a task optimistically.

Press `x` (clear listed) to delete the currently listed deletable inactive
tasks. The confirmation shows the count and scope: read-only tasks, omitted
tasks, and unseen history are kept. Press `y` to confirm, or `n`/Escape to
cancel. The viewer freezes the listed identities and rechecks each before
sending sequential delete requests. New arrivals are not included. Errors and
partial results remain visible after catalog updates until you leave the result
view. Escape during a batch stops queuing further requests; the current request
continues.

After a successful stop reply and a terminal catalog update, the viewer returns
to Active or closes if no active tasks remain. The stopped task remains in
Inactive history. Errors, unknown outcomes, and missing or stale catalogs do not
close the viewer. Natural completion does not leave inspection or history;
inspection remains refreshable while the task is in the catalog.

The compact widget suppresses short-lived work: a task appears only after
running for five seconds, then remains visible in its terminal state for at
least five seconds before leaving the panel.

All task plugins must be upgraded together when migrating from older task
packages. Mixed generations cannot coordinate their legacy widgets/commands with
this channel.

## Optional task controls

```ts
const tasks = registerTaskReporter(pi, "pwsh", {
  controls: {
    inspect: async (taskId) => inspectOwnedTask(taskId),
    stop: async (taskId) => stopOwnedTask(taskId), // optional
    delete: async (taskId) => deleteOwnedInactiveTask(taskId), // optional
  },
});
```

Callbacks return plain-text output and throw on failure. The source remains
responsible for task ownership, process lifecycle, and deletion of its inactive
task records. Publish an updated catalog after deletion. Both requester and
recipient validate the session, identity, advertised capability, and phase;
active tasks cannot be deleted. No bulk wire operation exists: cleanup sends one
source-owned delete request per eligible listed task. Output is sanitized and
capped at 16,000 characters with an explicit truncation notice. Put full-log
paths before large output when the source has them.

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
