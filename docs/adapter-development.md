# Adapter Development

Orb keeps messaging-platform code behind a narrow adapter boundary. If you add a new platform, the goal is to keep scheduler, worker, prompt assembly, and memory code untouched.

## PlatformAdapter Interface

Adapters implement `src/adapters/interface.js`.

```javascript
export class PlatformAdapter {
  async start(onMessage, onInteractive) {}
  async disconnect() {}
  async sendReply(channel, threadTs, text, extra) {}
  async editMessage(channel, ts, text, extra) {}
  async uploadFile(channel, threadTs, filePath, filename) {}
  async setTyping(channel, threadTs, status) {}
  async sendApproval(channel, threadTs, prompt) {}
  buildPayloads(text) {}
  async cleanupIndicator(channel, threadTs, typingSet, errorMsg) {}
  async fetchThreadHistory(threadTs, channel) { return null; }
  get botUserId() {}
  get platform() { return "unknown"; }
}
```

The scheduler only depends on these methods. It does not import platform SDKs directly.

## Method Responsibilities

### `start(onMessage, onInteractive)`

Bring up the transport and forward normalized incoming events to Orb.

The adapter should translate raw platform events into the task shape the scheduler expects:

```javascript
{
  userText,
  fileContent,
  imagePaths,
  threadTs,
  channel,
  userId,
  platform,
  threadHistory
}
```

### `sendReply(channel, threadTs, text, extra)`

Send a reply into the right conversation. `extra` can carry platform-native payloads such as Slack blocks.

### `editMessage(channel, ts, text, extra)`

Update an existing message. Orb uses this for progress updates and approval-card state changes.

### `uploadFile(channel, threadTs, filePath, filename)`

Upload a file produced by Claude Code.

### `setTyping(channel, threadTs, status)`

Turn a typing indicator on or off. The scheduler is the owner of typing state; workers emit lifecycle events.

### `sendApproval(channel, threadTs, prompt)`

Present an approval request to the user and return a decision object. In Slack, this powers permission approval cards.

### `buildPayloads(text)`

Convert plain text into one or more platform-native outbound payloads. This is where message splitting and rich rendering start.

### `fetchThreadHistory(threadTs, channel)`

Return a formatted representation of the existing thread so Orb can pass prior context to the worker.

## format-utils vs Adapter-Specific Formatting

Keep the boundary clean:

- `src/format-utils.js`: platform-agnostic helpers such as text sanitization and splitting
- `src/adapters/{platform}-format.js`: platform-specific rendering such as Slack `mrkdwn`, blocks, chunking, or platform card layouts

Do not put Slack-specific formatting rules in shared utilities.

## Registration Path

Adding an adapter requires two integration points.

### 1. Create The Adapter

Place the implementation in `src/adapters/{platform}.js`.

### 2. Register It In main.js

`src/main.js` is where enabled adapters are instantiated and started. Follow the existing Slack and WeChat branches:

```javascript
if (name === "myplatform") {
  const adapter = new MyPlatformAdapter(adapterConfig);
  scheduler.addAdapter(name, adapter);
  await adapter.start((task) => scheduler.submit(task));
}
```

The corresponding `config.json` entry should live under `adapters.myplatform`.

## Minimal Skeleton

```javascript
import { PlatformAdapter } from "./interface.js";

export class ConsoleAdapter extends PlatformAdapter {
  constructor(config = {}) {
    super();
    this.config = config;
  }

  get platform() {
    return "console";
  }

  async start(onMessage) {
    process.stdin.on("data", (chunk) => {
      onMessage({
        userText: chunk.toString().trim(),
        threadTs: "console-thread",
        channel: "console",
        userId: "local-user",
        platform: "console",
        threadHistory: null
      });
    });
  }

  async disconnect() {}

  async sendReply(channel, threadTs, text) {
    console.log(text);
  }

  buildPayloads(text) {
    return [{ text }];
  }
}
```

## Approval Flow Integration

If your platform supports interactive UI, implement `sendApproval()` and message updates so Orb can route permission requests back to the user.

If it does not, you can still support the platform for normal replies while leaving permission approval unavailable there. The scheduler already handles that distinction.

## Testing Strategy

Focus on behavior, not just transport startup:

- inbound message normalization
- thread identity and history fetch
- outbound reply chunking
- approval-card lifecycle if the platform supports interactions
- file upload handling
- error paths such as reconnects and expired tokens

The Slack adapter in `src/adapters/slack.js` is the best reference for the full contract, including approvals, progress updates, thread history, and rich payload rendering.

## Design Rule

If you find yourself adding platform-specific branches to `src/scheduler.js`, `src/worker.js`, or `src/context.js`, stop and move that logic back into the adapter.
