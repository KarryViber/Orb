# Adapter Development

Orb's platform abstraction lets you add new messaging platforms without touching the core scheduler or worker code.

## PlatformAdapter Interface

All adapters extend `PlatformAdapter` from `src/adapters/interface.js`:

```javascript
import { PlatformAdapter } from './interface.js';

export class MyAdapter extends PlatformAdapter {
  // Required
  async start(scheduler) { ... }
  async disconnect() { ... }
  async sendReply(channel, text, threadTs, options) { ... }

  // Optional
  async editMessage(channel, messageTs, text) { ... }
  async uploadFile(channel, filePath, filename, threadTs) { ... }
  async setTyping(channel, threadTs) { ... }
  async sendApproval(channel, threadTs, prompt) { ... }
  async fetchThreadHistory(channel, threadTs) { ... }
  buildPayloads(text, options) { ... }
}
```

## Method Reference

### `start(scheduler)`
Connect to the platform and begin receiving messages. Call `scheduler.handleMessage(payload)` for each incoming message.

`payload` shape:
```javascript
{
  userText: string,       // message text
  fileContent: string,    // attachment text content (optional)
  imagePaths: string[],   // local paths to downloaded images (optional)
  threadTs: string,       // thread identifier (unique per conversation)
  channel: string,        // channel/chat identifier
  userId: string,         // sender's platform user ID
  platform: string,       // e.g. 'slack'
  profile: object,        // resolved profile config
  threadHistory: string,  // formatted prior messages in thread (optional)
}
```

### `sendReply(channel, text, threadTs, options)`
Send a message. `options` can include platform-specific fields (e.g. Slack Block Kit payloads).

### `editMessage(channel, messageTs, text)`
Edit an existing message in-place (used for streaming updates).

### `uploadFile(channel, filePath, filename, threadTs)`
Upload a file as a reply.

### `setTyping(channel, threadTs)`
Show a typing indicator.

### `sendApproval(channel, threadTs, prompt)`
Send an approval request and wait for user response. Returns `{ approved, scope }`.

### `fetchThreadHistory(channel, threadTs)`
Return a formatted string of prior messages in the thread.

### `buildPayloads(text, options)`
Convert text and options into platform-native message payloads. Called by the scheduler before `sendReply`.

## Example: Minimal Adapter

```javascript
import { PlatformAdapter } from './interface.js';

export class ConsoleAdapter extends PlatformAdapter {
  async start(scheduler) {
    this.scheduler = scheduler;
    process.stdin.on('data', (data) => {
      scheduler.handleMessage({
        userText: data.toString().trim(),
        threadTs: 'console',
        channel: 'console',
        userId: 'local-user',
        platform: 'console',
        profile: this.config.profiles?.default,
      });
    });
  }

  async disconnect() {}

  async sendReply(channel, text) {
    console.log(`[bot] ${text}`);
  }
}
```

## Registering an Adapter

In `config.json`:
```json
{
  "adapters": {
    "myconsole": {
      "enabled": true
    }
  }
}
```

In `src/main.js`, import and instantiate your adapter alongside the existing ones.

## Format Utilities

Platform-specific text formatting belongs in `src/adapters/{platform}-format.js`. Platform-agnostic utilities (text sanitization, message splitting) go in `src/format-utils.js`.

See `src/adapters/slack-format.js` for a reference implementation (Markdown → mrkdwn conversion, Block Kit construction).
