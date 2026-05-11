import { info, warn } from '../../log.js';
import { ORB_STREAM_AUTO_ROTATE } from '../../runtime-env.js';
import { markdownToMrkdwn } from '../slack-format.js';
import {
  STREAM_TASK_FIELD_LIMIT,
  StreamAPIError,
  assertStreamTaskField,
  buildStreamAPIError,
  getSlackStreamErrorCode,
  isStreamingStateError,
  preserveStreamTaskField,
} from '../slack-stream-error.js';

const TAG = 'slack';
const AUTO_ROTATE_AFTER_MS = 240_000;
const AUTO_ROTATE_MARKER_CHUNK = {
  type: 'blocks',
  blocks: [{
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '↩️ 续' }],
  }],
};

function isIgnorableAssistantThreadError(err) {
  const code = String(err?.data?.error || err?.code || '').trim();
  return code === 'no_permission' || code === 'channel_not_found';
}

export function createStreamClient({
  webClient,
  getTeamId = () => null,
  streamTrace = () => false,
  postReply,
  autoRotateEnabled = () => ORB_STREAM_AUTO_ROTATE,
  autoRotateAfterMs = AUTO_ROTATE_AFTER_MS,
}) {
  const streams = new Map();

  function cloneChunk(chunk) {
    return chunk && typeof chunk === 'object' ? { ...chunk } : chunk;
  }

  function cloneChunks(chunks) {
    return (Array.isArray(chunks) ? chunks : []).map(cloneChunk);
  }

  function mergeSnapshot(stream, chunks) {
    if (!stream.snapshot) stream.snapshot = { plan: null, tasks: new Map() };
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'plan_update') {
        stream.snapshot.plan = cloneChunk(chunk);
      } else if (chunk.type === 'task_update') {
        const id = String(chunk.id || '').trim();
        if (!id) continue;
        const previous = stream.snapshot.tasks.get(id) || {};
        const next = { ...previous, ...cloneChunk(chunk) };
        if (typeof previous.details === 'string' && typeof chunk.details === 'string' && chunk.details && previous.details) {
          next.details = `${previous.details}${chunk.details}`;
        }
        stream.snapshot.tasks.set(id, next);
      }
    }
  }

  function snapshotChunks(stream) {
    if (typeof stream.rebuildInitialChunks === 'function') {
      const rebuilt = stream.rebuildInitialChunks();
      if (Array.isArray(rebuilt) && rebuilt.length > 0) return client.normalizeStreamChunks(rebuilt);
    }
    const chunks = [];
    if (stream.snapshot?.plan) chunks.push(cloneChunk(stream.snapshot.plan));
    if (stream.snapshot?.tasks) chunks.push(...[...stream.snapshot.tasks.values()].map(cloneChunk));
    return chunks.length > 0 ? chunks : cloneChunks(stream.initialChunks);
  }

  async function startSlackStream(channel, threadTs, {
    task_display_mode = 'timeline',
    initial_chunks = [],
    team_id = null,
  } = {}) {
    const normalizedTaskDisplayMode = client.normalizeTaskDisplayMode(task_display_mode);
    const initialChunks = client.normalizeStreamChunks(initial_chunks);
    const params = {
      channel,
      thread_ts: threadTs,
      task_display_mode: normalizedTaskDisplayMode,
      chunks: initialChunks.length > 0 ? initialChunks : [{ type: 'markdown_text', text: ' ' }],
      ...(await client._resolveStreamRecipient(channel, threadTs, team_id)),
    };

    let result;
    try {
      result = await webClient.apiCall('chat.startStream', params);
    } catch (err) {
      throw buildStreamAPIError('startStream', err.data?.error || err.message, err);
    }
    if (!result?.ok || !result?.ts) throw buildStreamAPIError('startStream', result?.error || 'missing_ts');
    return { result, normalizedTaskDisplayMode, initialChunks };
  }

  async function stopSlackStream(streamId, stream, { markdown_text, blocks, chunks, final_blocks } = {}) {
    const normalizedChunks = client.normalizeStreamChunks(chunks);
    const finalBlocks = Array.isArray(blocks) && blocks.length > 0
      ? blocks
      : Array.isArray(final_blocks) && final_blocks.length > 0
        ? final_blocks
        : null;
    const finalText = typeof markdown_text === 'string' ? markdownToMrkdwn(markdown_text.trim()) : '';
    if (finalText && streamTrace()) {
      info(TAG, `[slack:stopStream] emitting markdown_text as implicit post (len=${finalText.length}, channel=${stream.channel}, ts=${stream.ts})`);
    }
    if (finalText && normalizedChunks.length > 0) normalizedChunks.push({ type: 'markdown_text', text: finalText });
    const sendMarkdownTop = Boolean(finalText) && normalizedChunks.length === 0;

    let result;
    const lifeMs = stream.startedAt ? Date.now() - stream.startedAt : null;
    try {
      info(TAG, `[slack:stopStream] summary stream_id=${streamId} life_ms=${lifeMs} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0} final_len=${finalText.length} final_blocks=${finalBlocks ? finalBlocks.length : 0}`);
      result = await webClient.apiCall('chat.stopStream', {
        channel: stream.channel,
        ts: stream.ts,
        ...(normalizedChunks.length > 0 ? { chunks: normalizedChunks } : {}),
        ...(sendMarkdownTop ? { markdown_text: finalText } : {}),
        ...(finalBlocks ? { blocks: finalBlocks } : {}),
      });
    } catch (err) {
      info(TAG, `[slack:stopStream:error] stream_id=${streamId} error=${err.data?.error || err.message} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('stopStream', err.data?.error || err.message, err);
    }
    if (!result?.ok) {
      info(TAG, `[slack:stopStream:error] stream_id=${streamId} error=${result?.error || 'unknown_error'} total_appends=${stream.appendCount || 0} total_append_len=${stream.totalAppendLen || 0}`);
      throw buildStreamAPIError('stopStream', result?.error || 'unknown_error');
    }
  }

  function scheduleAutoRotate(streamId, stream) {
    if (!stream.autoRotate || stream.rotateTimer) return;
    stream.rotateTimer = setTimeout(() => {
      stream.rotateTimer = null;
      client.stopAndRotate(streamId).catch((err) => {
        warn(TAG, `[slack:autoRotate:error] stream_id=${streamId} error=${err.message}`);
      });
    }, stream.autoRotateAfterMs);
    if (typeof stream.rotateTimer.unref === 'function') stream.rotateTimer.unref();
  }

  const client = {
    normalizeTaskDisplayMode(mode) {
      return mode === 'aggregated' || mode === 'plan' ? 'plan' : 'timeline';
    },

    normalizeStreamChunks(chunks) {
      const normalized = [];
      const blocks = [];
      const pushTaskUpdate = (taskLike) => {
        if (!taskLike || typeof taskLike !== 'object') return;
        const id = String(taskLike.id || taskLike.task_id || '').trim();
        const title = assertStreamTaskField('title', taskLike.title || taskLike.text || '');
        if (!id || !title) return;

        const chunk = {
          type: 'task_update',
          id,
          title,
          status: taskLike.status === 'completed' ? 'complete' : taskLike.status,
        };

        if (!['pending', 'in_progress', 'complete', 'error'].includes(chunk.status)) chunk.status = 'in_progress';
        const details = typeof taskLike.details === 'string' ? preserveStreamTaskField('details', taskLike.details) : '';
        const output = typeof taskLike.output === 'string' ? assertStreamTaskField('output', taskLike.output) : '';
        if (details) chunk.details = details;
        if (output) chunk.output = output;
        if (Array.isArray(taskLike.sources) && taskLike.sources.length > 0) chunk.sources = taskLike.sources;
        normalized.push(chunk);
      };

      for (const chunk of Array.isArray(chunks) ? chunks : []) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'markdown_text') {
          const raw = String(chunk.text || chunk.markdown_text || '').trim();
          const text = raw ? markdownToMrkdwn(raw) : '';
          if (text) normalized.push({ type: 'markdown_text', text });
          continue;
        }
        if (chunk.type === 'task_update') {
          pushTaskUpdate(chunk.task && typeof chunk.task === 'object' ? chunk.task : chunk);
          continue;
        }
        if (chunk.type === 'task') {
          pushTaskUpdate(chunk);
          continue;
        }
        if (chunk.type === 'plan_update') {
          const title = String(chunk.title || '').trim();
          if (title) normalized.push({ type: 'plan_update', title: title.slice(0, STREAM_TASK_FIELD_LIMIT) });
          continue;
        }
        if (chunk.type === 'blocks') {
          if (Array.isArray(chunk.blocks) && chunk.blocks.length > 0) normalized.push(chunk);
          continue;
        }
        if (chunk.type === 'text') {
          const raw = String(chunk.text || '').trim();
          normalized.push({ type: 'markdown_text', text: raw ? markdownToMrkdwn(raw) : ' ' });
          continue;
        }
        blocks.push(chunk);
      }

      if (blocks.length > 0) normalized.push({ type: 'blocks', blocks });
      return normalized;
    },

    _getStreamHandle(streamId) {
      const stream = streams.get(streamId);
      if (!stream) throw new StreamAPIError(`unknown stream id: ${streamId}`);
      return stream;
    },

    async _resolveStreamRecipient(channel, threadTs, teamId = null) {
      if (!channel || !threadTs || String(channel).startsWith('D')) return {};
      const resolvedTeamId = getTeamId() || teamId || null;
      if (!resolvedTeamId) throw new StreamAPIError('missing Slack team_id for streaming API');

      try {
        const result = await webClient.conversations.replies({
          channel,
          ts: threadTs,
          limit: 1,
          inclusive: true,
        });
        const recipientUserId = result?.messages?.[0]?.user;
        if (!recipientUserId) throw new StreamAPIError(`failed to resolve recipient_user_id for thread ${threadTs}`);
        return { recipient_user_id: recipientUserId, recipient_team_id: resolvedTeamId };
      } catch (err) {
        if (err instanceof StreamAPIError) throw err;
        throw new StreamAPIError(`failed to resolve stream recipient: ${err.message}`, err);
      }
    },

    async startStream(channel, threadTs, {
      task_display_mode = 'timeline',
      initial_chunks = [],
      team_id = null,
      rebuild_initial_chunks = null,
      on_rotate = null,
      auto_rotate = null,
      rotate_after_ms = null,
    } = {}) {
      if (!threadTs) throw new StreamAPIError('chat.startStream requires thread_ts');
      const { result, normalizedTaskDisplayMode, initialChunks } = await startSlackStream(channel, threadTs, {
        channel,
        threadTs,
        task_display_mode,
        initial_chunks,
        team_id,
      });

      const streamId = `${channel}:${result.ts}`;
      const initialLen = initialChunks.reduce((s, c) => s + (c?.text?.length || 0), 0);
      info(TAG, `[slack:startStream] stream_id=${streamId} display_mode=${normalizedTaskDisplayMode} initial_chunks=${initialChunks.length} initial_len=${initialLen}`);
      const stream = {
        channel,
        threadTs,
        teamId: team_id,
        ts: result.ts,
        taskDisplayMode: normalizedTaskDisplayMode,
        initialChunks: cloneChunks(initialChunks),
        rebuildInitialChunks: typeof rebuild_initial_chunks === 'function' ? rebuild_initial_chunks : null,
        onRotate: typeof on_rotate === 'function' ? on_rotate : null,
        autoRotate: auto_rotate == null ? Boolean(autoRotateEnabled()) : Boolean(auto_rotate),
        autoRotateAfterMs: rotate_after_ms != null && Number.isFinite(Number(rotate_after_ms))
          ? Number(rotate_after_ms)
          : autoRotateAfterMs,
        startedAt: Date.now(),
        appendCount: 0,
        totalAppendLen: 0,
        lastAppendAt: null,
        snapshot: { plan: null, tasks: new Map() },
        rotating: null,
        rotateTimer: null,
      };
      mergeSnapshot(stream, initialChunks);
      streams.set(streamId, stream);
      scheduleAutoRotate(streamId, stream);
      return { stream_id: streamId, ts: result.ts };
    },

    async appendStream(streamId, chunks) {
      const stream = client._getStreamHandle(streamId);
      if (stream.rotating) await stream.rotating.catch(() => {});
      const normalizedChunks = client.normalizeStreamChunks(chunks);
      if (normalizedChunks.length === 0) return;
      mergeSnapshot(stream, normalizedChunks);
      const appendLen = normalizedChunks.reduce((s, c) => s + (c?.text?.length || 0), 0);

      let result;
      try {
        result = await webClient.apiCall('chat.appendStream', {
          channel: stream.channel,
          ts: stream.ts,
          chunks: normalizedChunks,
        });
      } catch (err) {
        if (isStreamingStateError(err) || getSlackStreamErrorCode(err) === 'message_not_owned_by_app') streams.delete(streamId);
        info(TAG, `[slack:appendStream:error] stream_id=${streamId} error=${err.data?.error || err.message} chunks=${normalizedChunks.length} len=${appendLen} n=${stream.appendCount || 0} total_len=${stream.totalAppendLen || 0}`);
        throw buildStreamAPIError('appendStream', err.data?.error || err.message, err);
      }
      if (!result?.ok) {
        if (isStreamingStateError(result) || getSlackStreamErrorCode(result) === 'message_not_owned_by_app') streams.delete(streamId);
        info(TAG, `[slack:appendStream:error] stream_id=${streamId} error=${result?.error || 'unknown_error'} chunks=${normalizedChunks.length} len=${appendLen} n=${stream.appendCount || 0} total_len=${stream.totalAppendLen || 0}`);
        throw buildStreamAPIError('appendStream', result?.error || 'unknown_error');
      }
      const now = Date.now();
      const sinceLast = stream.lastAppendAt ? now - stream.lastAppendAt : null;
      stream.appendCount = (stream.appendCount || 0) + 1;
      stream.totalAppendLen = (stream.totalAppendLen || 0) + appendLen;
      stream.lastAppendAt = now;
      const lifeMs = stream.startedAt ? now - stream.startedAt : null;
      if (streamTrace()) {
        info(TAG, `[slack:appendStream] stream_id=${streamId} chunks=${normalizedChunks.length} len=${appendLen} since_last_ms=${sinceLast ?? 'null'} n=${stream.appendCount} total_len=${stream.totalAppendLen} life_ms=${lifeMs}`);
      }
    },

    async stopAndRotate(streamId) {
      const stream = client._getStreamHandle(streamId);
      if (!stream.autoRotate) return { rotated: false, stream_id: streamId, ts: stream.ts };
      if (stream.rotating) return stream.rotating;
      stream.rotating = (async () => {
        const prevStreamId = `${stream.channel}:${stream.ts}`;
        const prevTs = stream.ts;
        const finalChunks = snapshotChunks(stream);
        if (stream.rotateTimer) {
          clearTimeout(stream.rotateTimer);
          stream.rotateTimer = null;
        }
        await stopSlackStream(prevStreamId, stream, { chunks: finalChunks });
        const nextInitialChunks = [
          AUTO_ROTATE_MARKER_CHUNK,
          ...snapshotChunks(stream),
        ];
        const { result, initialChunks } = await startSlackStream(stream.channel, stream.threadTs, {
          task_display_mode: stream.taskDisplayMode,
          initial_chunks: nextInitialChunks,
          team_id: stream.teamId,
        });
        const newStreamId = `${stream.channel}:${result.ts}`;
        streams.delete(prevStreamId);
        stream.ts = result.ts;
        stream.startedAt = Date.now();
        stream.appendCount = 0;
        stream.totalAppendLen = 0;
        stream.lastAppendAt = null;
        stream.initialChunks = cloneChunks(initialChunks);
        stream.snapshot = { plan: null, tasks: new Map() };
        mergeSnapshot(stream, initialChunks);
        stream.rotating = null;
        streams.set(newStreamId, stream);
        if (prevStreamId !== streamId) streams.delete(streamId);
        scheduleAutoRotate(newStreamId, stream);
        info(TAG, `[slack:autoRotate] auto_rotated=true rotate_at_ms=${stream.autoRotateAfterMs} prev_stream_id=${prevStreamId} new_stream_id=${newStreamId}`);
        await stream.onRotate?.({
          reason: 'auto-rotate',
          prev_stream_id: prevStreamId,
          prev_ts: prevTs,
          stream_id: newStreamId,
          ts: result.ts,
        });
        return { rotated: true, stream_id: newStreamId, ts: result.ts };
      })().finally(() => {
        if (stream.rotating) stream.rotating = null;
      });
      return stream.rotating;
    },

    async stopStream(streamId, { markdown_text, blocks, chunks, final_blocks } = {}) {
      const stream = client._getStreamHandle(streamId);
      if (stream.rotating) await stream.rotating.catch(() => {});
      if (stream.rotateTimer) {
        clearTimeout(stream.rotateTimer);
        stream.rotateTimer = null;
      }
      try {
        await stopSlackStream(streamId, stream, { markdown_text, blocks, chunks, final_blocks });
      } finally {
        streams.delete(streamId);
      }
    },

    async setThreadStatus(channel, threadTs, status, loadingMessages) {
      if (!channel || !threadTs) return;
      try {
        const payload = {
          channel_id: channel,
          thread_ts: threadTs,
          status: String(status || ''),
        };
        if (Array.isArray(loadingMessages) && loadingMessages.length > 0) {
          payload.loading_messages = loadingMessages.slice(0, 10).map(String);
        }
        await webClient.apiCall('assistant.threads.setStatus', payload);
      } catch (err) {
        if (isIgnorableAssistantThreadError(err)) return;
        warn(TAG, `setThreadStatus failed: ${err.message}`);
      }
    },

    async setThreadTitle(channel, threadTs, title) {
      if (!channel || !threadTs || !title) return;
      try {
        await webClient.apiCall('assistant.threads.setTitle', {
          channel_id: channel,
          thread_ts: threadTs,
          title: String(title).trim().slice(0, 60),
        });
      } catch (err) {
        if (isIgnorableAssistantThreadError(err)) return;
        warn(TAG, `setThreadTitle failed: ${err.message}`);
      }
    },

    async setSuggestedPrompts(channel, threadTs, prompts) {
      if (!channel || !threadTs || !Array.isArray(prompts) || prompts.length === 0) return;
      const normalizedPrompts = prompts
        .filter((prompt) => prompt?.title && prompt?.message)
        .slice(0, 4)
        .map((prompt) => ({
          title: String(prompt.title).trim().slice(0, 60),
          message: String(prompt.message).trim().slice(0, 200),
        }));
      if (normalizedPrompts.length === 0) return;
      try {
        await webClient.apiCall('assistant.threads.setSuggestedPrompts', {
          channel_id: channel,
          thread_ts: threadTs,
          prompts: normalizedPrompts,
        });
      } catch (err) {
        if (isIgnorableAssistantThreadError(err)) return;
        warn(TAG, `setSuggestedPrompts failed: ${err.message}`);
      }
    },

    async setTyping(channel, threadTs, status) {
      await client.setThreadStatus(channel, threadTs, status);
    },

    async cleanupIndicator(channel, threadTs, typingSet, errorMsg) {
      if (typingSet) await client.setThreadStatus(channel, threadTs, '').catch(() => {});
      try {
        await postReply(channel, threadTs, markdownToMrkdwn(`:warning: ${errorMsg}`));
      } catch (err) {
        warn(TAG, `failed to send error msg: ${err.message}`);
      }
    },
  };

  return client;
}
