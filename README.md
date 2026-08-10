# @4fu/pi-tasks

Dependency-only shared task presentation runtime for Pi extensions. Source plugins call `registerTaskReporter(pi, source)` and publish their current catalog. Instances loaded from separate dependency roots coordinate exclusively through the stable `@4fu/pi-tasks/v1` `pi.events` channel. A synchronous probe elects one presentation owner, which alone registers `/tasks` and owns the stable above-editor widget.

## Usage

```ts
import { registerTaskReporter } from "@4fu/pi-tasks";
const tasks = registerTaskReporter(pi, "python");
tasks.publishCatalog(sessionId, currentTasks);
```

The package is installed transitively by task source plugins; users normally do not install or configure it directly. Run `/tasks` in interactive mode for a read-only, scrollable snapshot containing active and recent terminal tasks. The compact widget suppresses short-lived work: a task appears only after running for five seconds, then remains visible in its terminal state for at least five seconds before leaving the panel.

All task plugins must be upgraded together when migrating from older task packages. Mixed generations cannot coordinate their legacy widgets/commands with this channel.

## Development

Requires Node 22.19 or newer. Run `npm install --ignore-scripts`, `npm test`, and `npm pack --dry-run`.
