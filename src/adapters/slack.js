import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { createReadStream } from 'node:fs';
import { info, error as logError, warn } from '../log.js';
import {
  buildSendPayloads,
  extractSuggestedPrompts,
  markdownToMrkdwn,
} from './slack-format.js';
import { PlatformAdapter } from './interface.js';
import { cleanImageCache } from './image-cache.js';
import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TEXT_FINAL,
  METADATA_STATUS,
  METADATA_TITLE,
  TASK_PROGRESS_APPEND,
  TASK_PROGRESS_START,
  TASK_PROGRESS_STOP,
} from '../turn-delivery/intents.js';
import { createTurnDeliveryCcEventSubscriber } from '../turn-delivery/cc-event-subscriber.js';
import { IMAGE_CACHE_DIR, ORB_STREAM_TRACE } from '../runtime-env.js';
import { createThreadContextHelper } from './slack/thread-context.js';
import { createApprovalController } from './slack/approval-controller.js';
import { createStreamClient } from './slack/stream-client.js';
import { createMessageRouter } from './slack/message-router.js';
import { dispatchViewSubmissionHandler } from './slack-block-actions.js';
import { renderCronBlocks } from '../cron-delivery.js';

const TAG = 'slack';
const streamTrace = () => ORB_STREAM_TRACE;
const AUQ_TITLE = '📝 Orb needs you...';

function isStreamOwnershipError(err) {
  const code = err?.data?.error || err?.slackErrorCode || err?.code || '';
  return code === 'message_not_in_streaming_state' || code === 'message_not_owned_by_app';
}

function slackPlainText(text, maxLength = 75) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLength) || 'Option';
}

function auqValue({ requestId, qIdx = null, optIdx = null }) {
  return JSON.stringify({ requestId, qIdx, optIdx });
}

export class SlackAdapter extends PlatformAdapter {
  constructor({ botToken, appToken, allowBots, replyBroadcast, freeResponseChannels, freeResponseUsers, dmRouting, getProfilePaths, ledger }) {
    super();
    this._botToken = botToken;
    this._slack = new WebClient(botToken);
    this._socket = new SocketModeClient({ appToken });
    this._allowBots = allowBots || 'none';
    this._replyBroadcast = replyBroadcast || false;
    this._freeResponseChannels = freeResponseChannels || new Set();
    this._freeResponseUsers = freeResponseUsers || new Set();
    this._dmRouting = dmRouting || null;
    this._getProfilePaths = getProfilePaths || null;
    this._ledger = ledger || null;
    this._botUserId = null;
    this._botId = null;
    this._teamId = null;
    this._imageCacheDir = IMAGE_CACHE_DIR;
    this._cleanupInterval = null;
    this._statusSubscriber = null;
    this.onMessage = null;
    this.onInteractive = null;
    this.onReaction = null;

    const webClient = new Proxy({}, {
      get: (_target, prop) => this._slack?.[prop],
    });

    this._threadContext = createThreadContextHelper({
      webClient,
      botToken,
      imageCacheDir: this._imageCacheDir,
      getProfilePaths,
      getBotId: () => this._botId,
    });

    this._approvalController = createApprovalController({
      webClient,
      getProfilePaths,
      resolveLedger: (hint) => this._resolveAdapterEventLedger(hint),
    });

    this._streamClient = createStreamClient({
      webClient,
      getTeamId: () => this._teamId,
      streamTrace,
      postReply: (channel, threadTs, text, extra = {}) => this._postReply(channel, threadTs, text, extra),
    });

    this._messageRouter = createMessageRouter({
      webClient,
      allowBots: this._allowBots,
      freeResponseChannels: this._freeResponseChannels,
      freeResponseUsers: this._freeResponseUsers,
      dmRouting: this._dmRouting,
      resolveLedger: (hint) => this._resolveAdapterEventLedger(hint),
      threadContext: this._threadContext,
      approvalController: this._approvalController,
      getBotUserId: () => this._botUserId,
      getBotId: () => this._botId,
      getTeamId: () => this._teamId,
      getOnMessage: () => this.onMessage,
      getOnReaction: () => this.onReaction,
    });

    this._pendingApprovals = this._approvalController._pendingApprovals;
    this._blockActionInFlight = this._approvalController._blockActionInFlight;
    this._pendingAskUserQuestions = new Map();
  }

  get botUserId() {
    return this._botUserId;
  }

  get platform() {
    return 'slack';
  }

  get supportsInteractiveApproval() {
    return true;
  }

  get capabilities() {
    return { stream: true, edit: true, metadata: true };
  }

  installCcEventSubscriber(eventBus) {
    if (this.__orbTurnDeliveryCcEventUnsubscribe) return;
    this.__orbTurnDeliveryCcEventSubscriber = createTurnDeliveryCcEventSubscriber();
    this.__orbTurnDeliveryCcEventUnsubscribe = eventBus.subscribe(this.__orbTurnDeliveryCcEventSubscriber);
  }

  _resolveAdapterEventLedger(hint = {}) {
    if (typeof this._ledger !== 'function') return this._ledger || null;
    try {
      return this._ledger(hint) || null;
    } catch (err) {
      warn(TAG, `ledger resolve failed: ${err.message}`);
      return null;
    }
  }

  setAdapterEventLedgerResolver(ledger) {
    this._ledger = ledger || null;
  }

  _isDuplicate(eventTs) {
    return this._threadContext._isDuplicate(eventTs);
  }

  _trackThread(threadTs) {
    return this._threadContext._trackThread(threadTs);
  }

  _isTrackedThread(threadTs) {
    return this._threadContext._isTrackedThread(threadTs);
  }

  _cleanupTrackedThreads() {
    this._threadContext._cleanupTrackedThreads();
    this._messageRouter._cleanupMessageRouter();
  }

  _trackBotMessage(ts) {
    return this._messageRouter._trackBotMessage(ts);
  }

  _isBotThread(threadTs) {
    return this._messageRouter._isBotThread(threadTs);
  }

  async _isAssistantThreadRoot(channel, threadTs) {
    return this._threadContext._isAssistantThreadRoot(channel, threadTs);
  }

  async _resolveUserName(userId) {
    return this._threadContext._resolveUserName(userId);
  }

  async fetchThreadHistory(threadTs, channel, options = {}) {
    return this._threadContext.fetchThreadHistory(threadTs, channel, options);
  }

  async fetchChannelMeta(channelId) {
    return this._threadContext.fetchChannelMeta(channelId);
  }

  async _processIncomingFiles(files) {
    return this._threadContext._processIncomingFiles(files);
  }

  async _downloadDMFile(file, event, userId) {
    return this._threadContext._downloadDMFile(file, event, userId);
  }

  _buildApprovalBlocks(prompt, approvalId) {
    return this._approvalController._buildApprovalBlocks(prompt, approvalId);
  }

  _buildPermissionApprovalBlocks(prompt, approvalId) {
    return this._approvalController._buildPermissionApprovalBlocks(prompt, approvalId);
  }

  _truncateForSlackCodeBlock(value, maxChars) {
    return this._approvalController._truncateForSlackCodeBlock(value, maxChars);
  }

  _approvalFallbackText(prompt) {
    return this._approvalController._approvalFallbackText(prompt);
  }

  _approvalTimeoutReason(prompt) {
    return this._approvalController._approvalTimeoutReason(prompt);
  }

  _buildApprovalStatusBlocks(pending, label, extraText) {
    return this._approvalController._buildApprovalStatusBlocks(pending, label, extraText);
  }

  async sendApproval(channel, threadTs, prompt) {
    return this._approvalController.sendApproval(channel, threadTs, prompt);
  }

  _buildAskUserQuestionBlocks({ requestId, questions, socketPath }) {
    const normalizedQuestions = Array.isArray(questions) ? questions.slice(0, 4) : [];
    const blocks = [
      { type: 'header', block_id: `orb_auq_${requestId}_title`, text: { type: 'plain_text', text: AUQ_TITLE, emoji: true } },
    ];

    if (normalizedQuestions.length === 1) {
      const question = normalizedQuestions[0] || {};
      const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
      blocks.push({
        type: 'section',
        block_id: `orb_auq_${requestId}_question_0`,
        text: { type: 'mrkdwn', text: `*${markdownToMrkdwn(question.header || 'Question')}*\n${markdownToMrkdwn(question.question || '')}` },
      });
      blocks.push({
        type: 'actions',
        block_id: `orb_auq_${requestId}_actions_0`,
        elements: [
          ...options.map((option, optIdx) => ({
            type: 'button',
            text: { type: 'plain_text', text: slackPlainText(option.label), emoji: true },
            action_id: `orb_auq_pick_0_${optIdx}`,
            value: auqValue({ requestId, qIdx: 0, optIdx }),
            ...(optIdx === 0 ? { style: 'primary' } : {}),
          })),
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Other...', emoji: true },
            action_id: 'orb_auq_pick_0_other',
            value: auqValue({ requestId, qIdx: 0, optIdx: 'other' }),
          },
        ],
      });
      return blocks;
    }

    normalizedQuestions.forEach((question, qIdx) => {
      const options = (Array.isArray(question.options) ? question.options.slice(0, 4) : []).map((option, optIdx) => {
        const element = {
          text: { type: 'plain_text', text: slackPlainText(option.label), emoji: true },
          value: auqValue({ requestId, qIdx, optIdx }),
        };
        if (option.description) {
          element.description = { type: 'plain_text', text: slackPlainText(option.description, 75), emoji: true };
        }
        return element;
      });
      options.push({
        text: { type: 'plain_text', text: 'Other...', emoji: true },
        value: auqValue({ requestId, qIdx, optIdx: 'other' }),
      });
      if (qIdx > 0) {
        blocks.push({ type: 'divider', block_id: `orb_auq_${requestId}_divider_${qIdx}` });
      }
      const headerText = slackPlainText(`${qIdx + 1}. ${question.header || `Question ${qIdx + 1}`}`, 150);
      blocks.push({
        type: 'header',
        block_id: `orb_auq_${requestId}_qheader_${qIdx}`,
        text: { type: 'plain_text', text: headerText, emoji: true },
      });
      blocks.push({
        type: 'section',
        block_id: `orb_auq_${requestId}_question_${qIdx}`,
        text: { type: 'mrkdwn', text: markdownToMrkdwn(question.question || '') },
      });
      blocks.push({
        type: 'actions',
        block_id: `orb_auq_${requestId}_select_${qIdx}`,
        elements: [{
          type: question.multiSelect ? 'checkboxes' : 'radio_buttons',
          action_id: `orb_auq_select_${qIdx}`,
          options,
        }],
      });
    });
    blocks.push({
      type: 'actions',
      block_id: `orb_auq_${requestId}_submit`,
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Submit', emoji: true },
        style: 'primary',
        action_id: 'orb_auq_submit',
        value: auqValue({ requestId }),
      }],
    });
    return blocks;
  }

  _buildAskUserQuestionStatusBlocks(pending, answers = {}, options = {}) {
    const status = options.status || 'submitted';
    if (status === 'cancelled') {
      return [{ type: 'context', elements: [{ type: 'mrkdwn', text: '已取消 · worker 已结束，未收到回答' }] }];
    }
    const blocks = [];
    const questions = Array.isArray(pending?.questions) ? pending.questions : [];
    questions.forEach((question) => {
      const key = String(question.question || '');
      const header = String(question.header || key || 'Question');
      const answer = answers?.[key] || '(no answer)';
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `✓ *${markdownToMrkdwn(header)}*: ${markdownToMrkdwn(answer)}` }] });
    });
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    const jstNow = `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `已提交 · ${jstNow} JST` }] });
    return blocks;
  }

  async sendAskUserQuestion({ channel, threadTs, requestId, questions, socketPath = null }) {
    const blocks = this._buildAskUserQuestionBlocks({ requestId, questions, socketPath });
    const msg = await this._slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: AUQ_TITLE,
      blocks,
    });
    this._pendingAskUserQuestions.set(requestId, { channel, threadTs, messageTs: msg.ts, questions, blocks });
    if (msg.ts) {
      this._messageRouter._trackBotMessage(threadTs);
      this._messageRouter._trackBotReply(msg.ts);
    }
    return { ts: msg.ts };
  }

  async updateAskUserQuestionCard(requestId, answers = {}, options = {}) {
    const pending = this._pendingAskUserQuestions.get(requestId);
    if (!pending) return null;
    const blocks = this._buildAskUserQuestionStatusBlocks(pending, answers, options);
    const text = options.status === 'cancelled' ? 'AskUserQuestion cancelled' : 'AskUserQuestion answered';
    const result = await this._slack.chat.update({
      channel: pending.channel,
      ts: pending.messageTs,
      text,
      blocks,
    });
    this._pendingAskUserQuestions.delete(requestId);
    return result;
  }

  async openOtherModal({ triggerId, requestId, qIdx, question, header, isMulti }) {
    return this._slack.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: `orb_auq_other_${requestId}_${qIdx}`,
        private_metadata: JSON.stringify({ requestId, qIdx, question, header, is_multi: Boolean(isMulti) }),
        title: { type: 'plain_text', text: slackPlainText(header || 'Other', 24), emoji: true },
        submit: { type: 'plain_text', text: 'Submit', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [{
          type: 'input',
          block_id: 'orb_auq_other_value',
          label: { type: 'plain_text', text: 'Other', emoji: true },
          hint: { type: 'plain_text', text: slackPlainText(question || header || 'Answer', 150), emoji: true },
          element: {
            type: 'plain_text_input',
            action_id: 'value',
            multiline: false,
            max_length: 200,
          },
        }],
      },
    });
  }

  async cancelAskUserQuestionCard({ channel, messageTs, reason }) {
    if (!channel || !messageTs) return null;
    const text = `⏱ 已取消 · ${reason || 'worker exited'} · ${new Date().toISOString()}`;
    return this._slack.chat.update({
      channel,
      ts: messageTs,
      text: 'AskUserQuestion cancelled',
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }],
    });
  }

  async _handleInteractive({ body, ack }) {
    if (body?.type === 'view_submission' && /^orb_auq_other_/.test(String(body.view?.callback_id || ''))) {
      return dispatchViewSubmissionHandler({
        body,
        ack,
        slack: this._slack,
        getProfilePaths: this._getProfilePaths,
        resolveLedger: (hint) => this._resolveAdapterEventLedger(hint),
      });
    }
    return this._approvalController._handleInteractive({ body, ack });
  }

  _releaseBlockActionMessage(messageTs) {
    return this._approvalController._releaseBlockActionMessage(messageTs);
  }

  _handleMessageChanged(event) {
    return this._approvalController._handleMessageChanged(event);
  }

  async _updateBlockActionCard(channel, messageTs, text, originalBlocks = null, ledgerHint = {}) {
    return this._approvalController._updateBlockActionCard(channel, messageTs, text, originalBlocks, ledgerHint);
  }

  async _postReply(channel, threadTs, text, extra = {}) {
    const params = { channel, thread_ts: threadTs, text, ...extra };
    if (this._replyBroadcast) params.reply_broadcast = true;
    const result = await this._slack.chat.postMessage(params);
    if (result.ts) {
      this._messageRouter._trackBotMessage(threadTs);
      this._messageRouter._trackBotReply(result.ts);
    }
    return result;
  }

  async _editMessage(channel, ts, text, extra = {}) {
    return this._slack.chat.update({ channel, ts, text, ...extra });
  }

  async sendReply(channel, threadTs, text, extra = {}) {
    return this._postReply(channel, threadTs, text, extra);
  }

  async deliverCronOutput({ channel, threadTs, output }) {
    const text = output?.main || '[cron delivery]';
    const rendered = renderCronBlocks(output?.blocks);
    const threadMd = output?.thread_md || null;
    const main = await this.sendReply(channel, threadTs || undefined, text);
    const effectiveThreadTs = threadTs || main.ts || undefined;
    let deliveredCount = 1;
    if (threadMd) {
      await this.sendReply(channel, effectiveThreadTs, threadMd);
      deliveredCount += 1;
    }
    if (rendered.blocks || rendered.attachments) {
      const extra = {};
      if (rendered.blocks) extra.blocks = rendered.blocks;
      if (rendered.attachments) extra.attachments = rendered.attachments;
      await this.sendReply(channel, effectiveThreadTs, ' ', extra);
      deliveredCount += 1;
    }
    return { ts: main.ts || null, deliveredCount };
  }

  async editMessage(channel, ts, text, extra = {}) {
    return this._editMessage(channel, ts, text, extra);
  }

  async deliver(intent, { channel: deliveryChannel, turnState } = {}) {
    const slackChannel = intent.channel || turnState?.channel;
    const threadTs = intent.threadTs || turnState?.threadTs;
    const text = String(intent.text || '');
    const meta = intent.meta || {};

    if (deliveryChannel === 'stream') {
      const streamChannel = meta.streamChannel || 'qi';
      const streamId = meta.streamId || turnState?.streamIds?.[streamChannel] || turnState?.streamId;
      const streamMessageTs = turnState?.streamMessageTsByChannel?.[streamChannel] || turnState?.streamMessageTs || null;
      if (intent.intent === TASK_PROGRESS_START) {
        return this.startStream(slackChannel, threadTs, {
          task_display_mode: meta.task_display_mode || 'plan',
          initial_chunks: meta.chunks || [],
          team_id: meta.teamId || null,
          rebuild_initial_chunks: meta.rebuildInitialChunks,
          auto_rotate: meta.autoRotate,
          rotate_after_ms: meta.rotateAfterMs,
          on_rotate: (rotation) => {
            const nextStreamId = rotation?.stream_id || null;
            const nextTs = rotation?.ts || null;
            if (!turnState.streamIds) turnState.streamIds = {};
            if (!turnState.streamMessageTsByChannel) turnState.streamMessageTsByChannel = {};
            turnState.streamIds[streamChannel] = nextStreamId;
            turnState.streamMessageTsByChannel[streamChannel] = nextTs;
            if (turnState.taskCardStates?.[streamChannel]) {
              turnState.taskCardStates[streamChannel].streamId = nextStreamId;
              turnState.taskCardStates[streamChannel].streamMessageTs = nextTs;
            }
            if (streamChannel === 'qi') {
              turnState.streamId = nextStreamId;
              turnState.streamMessageTs = nextTs;
            }
            meta.onRotate?.(rotation);
          },
        });
      }
      if (intent.intent === TASK_PROGRESS_APPEND) {
        await this.appendStream(streamId, meta.chunks || [{ type: 'markdown_text', text }]);
        return { streamId, ts: streamMessageTs };
      }
      if (intent.intent === TASK_PROGRESS_STOP) {
        let finalBlocks = null;
        if (meta.gitDiffSummary?.hasChanges || meta.dailyNotesSummary?.count) {
          finalBlocks = this.buildPayloads('', {
            gitDiffSummary: meta.gitDiffSummary,
            dailyNotesSummary: meta.dailyNotesSummary,
          }).flatMap((payload) => payload.blocks || []);
        }
        await this.stopStream(streamId, {
          chunks: meta.chunks || [],
          final_blocks: finalBlocks,
        });
        return { streamId, ts: streamMessageTs };
      }
      if (intent.intent === ASSISTANT_TEXT_DELTA) {
        await this.appendStream(turnState.streamId, [{ type: 'markdown_text', text }]);
        return { streamId: turnState.streamId, ts: turnState.streamMessageTs || null };
      }
      if (intent.intent === ASSISTANT_TEXT_FINAL) {
        let finalBlocks = null;
        if (meta.gitDiffSummary?.hasChanges || meta.dailyNotesSummary?.count) {
          finalBlocks = this.buildPayloads('', {
            gitDiffSummary: meta.gitDiffSummary,
            dailyNotesSummary: meta.dailyNotesSummary,
          })
            .flatMap((payload) => payload.blocks || []);
        }
        try {
          await this.stopStream(turnState.streamId, {
            markdown_text: turnState.assistantStreamTextLen > 0 ? '' : text,
            final_blocks: finalBlocks,
          });
        } catch (err) {
          if (!isStreamOwnershipError(err) || !finalBlocks?.length) throw err;
          const payloads = this.buildPayloads('', {
            gitDiffSummary: meta.gitDiffSummary || null,
            dailyNotesSummary: meta.dailyNotesSummary || null,
          });
          let lastTs = null;
          for (const payload of payloads) {
            const result = await this.sendReply(slackChannel, threadTs, payload.text, payload.blocks ? { blocks: payload.blocks } : {});
            lastTs = result?.ts || lastTs;
          }
          return { streamId: turnState.streamId, ts: lastTs };
        }
        return { streamId: turnState.streamId, ts: turnState.streamMessageTs || null };
      }
    }

    if (deliveryChannel === 'postMessage') {
      if (intent.intent === 'launcher_result_card') {
        const result = await this.sendReply(slackChannel, threadTs, text);
        return { ts: result?.ts || null };
      }
      if (Array.isArray(meta.blocks) && meta.blocks.length > 0) {
        const result = await this.sendReply(slackChannel, threadTs, text, { blocks: meta.blocks });
        return { ts: result?.ts || null };
      }
      const payloads = this.buildPayloads(text, {
        gitDiffSummary: meta.gitDiffSummary || null,
        dailyNotesSummary: meta.dailyNotesSummary || null,
      });
      let lastTs = null;
      for (const payload of payloads) {
        const result = await this.sendReply(slackChannel, threadTs, payload.text, payload.blocks ? { blocks: payload.blocks } : {});
        lastTs = result?.ts || lastTs;
      }
      return { ts: lastTs };
    }

    if (deliveryChannel === 'edit') {
      if (!meta.ts) return { ts: null };
      const result = await this.editMessage(slackChannel, meta.ts, text, meta.blocks ? { blocks: meta.blocks } : {});
      return { ts: result?.ts || meta.ts };
    }

    if (deliveryChannel === 'metadata') {
      if (intent.intent === METADATA_STATUS) {
        await this.setThreadStatus(slackChannel, threadTs, text, meta.loadingMessages || null);
      } else if (intent.intent === METADATA_TITLE) {
        const title = text.split('\n')[0].trim().slice(0, 60);
        if (title) await this.setThreadTitle(slackChannel, threadTs, title);
        const prompts = extractSuggestedPrompts(text);
        if (prompts.length > 0) await this.setSuggestedPrompts(slackChannel, threadTs, prompts);
      }
      return { ts: null };
    }

    if (deliveryChannel === 'silent') return { ts: null };
    throw new Error(`unknown delivery channel: ${deliveryChannel}`);
  }

  clearStatusByContext({ channel, threadTs } = {}) {
    this.__orbTurnDeliveryCcEventSubscriber?.clearByContext?.({ channel, threadTs });
  }

  normalizeTaskDisplayMode(mode) {
    return this._streamClient.normalizeTaskDisplayMode(mode);
  }

  normalizeStreamChunks(chunks) {
    return this._streamClient.normalizeStreamChunks(chunks);
  }

  _getStreamHandle(streamId) {
    return this._streamClient._getStreamHandle(streamId);
  }

  async _resolveStreamRecipient(channel, threadTs, teamId = null) {
    return this._streamClient._resolveStreamRecipient(channel, threadTs, teamId);
  }

  async startStream(channel, threadTs, options = {}) {
    return this._streamClient.startStream(channel, threadTs, options);
  }

  async appendStream(streamId, chunks) {
    return this._streamClient.appendStream(streamId, chunks);
  }

  async stopStream(streamId, payload = {}) {
    return this._streamClient.stopStream(streamId, payload);
  }

  async uploadFile(channel, threadTs, filePath, filename) {
    try {
      await this._slack.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: createReadStream(filePath),
        filename: filename || filePath.split('/').pop(),
      });
      info(TAG, `uploaded file: ${filename || filePath}`);
    } catch (err) {
      logError(TAG, `file upload failed: ${err.message}`);
      await this._postReply(channel, threadTs, markdownToMrkdwn(`:warning: 文件上传失败: ${filename || filePath}`));
    }
  }

  async setThreadStatus(channel, threadTs, status, loadingMessages) {
    return this._streamClient.setThreadStatus(channel, threadTs, status, loadingMessages);
  }

  async setThreadTitle(channel, threadTs, title) {
    return this._streamClient.setThreadTitle(channel, threadTs, title);
  }

  async setSuggestedPrompts(channel, threadTs, prompts) {
    return this._streamClient.setSuggestedPrompts(channel, threadTs, prompts);
  }

  async setTyping(channel, threadTs, status) {
    return this._streamClient.setTyping(channel, threadTs, status);
  }

  buildPayloads(text, options = {}) {
    return buildSendPayloads(text, options);
  }

  async cleanupIndicator(channel, threadTs, typingSet, errorMsg) {
    return this._streamClient.cleanupIndicator(channel, threadTs, typingSet, errorMsg);
  }

  async disconnect() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._socket.disconnect();
  }

  async _routeDMMessage(event) {
    return this._messageRouter._routeDMMessage(event);
  }

  async _handleMessage({ event, ack }) {
    return this._messageRouter._handleMessage({ event, ack });
  }

  async _handleReaction({ event, ack }) {
    return this._messageRouter._handleReaction({ event, ack });
  }

  async _fetchThreadForReaction(channel, botMessageTs) {
    return this._messageRouter._fetchThreadForReaction(channel, botMessageTs);
  }

  async start(onMessage, onInteractive) {
    this.onMessage = onMessage;
    this.onInteractive = onInteractive;

    const auth = await this._slack.auth.test();
    this._botUserId = auth.user_id;
    this._botId = auth.bot_id;
    this._teamId = auth.team_id || null;
    info(TAG, `booted as @${auth.user} (${this._botUserId}, bot=${this._botId})`);

    const safeHandle = (eventType, handler) => async (evt, ...rest) => {
      try {
        return await handler.call(this, evt, ...rest);
      } catch (err) {
        const event = evt?.event || evt?.body || evt || {};
        logError(
          TAG,
          `slack handler ${eventType} failed: ${err.message} eventType=${eventType} channel=${event.channel || event.channel_id || null} thread_ts=${event.thread_ts || null} user=${event.user || event.user_id || null} ts=${event.event_ts || event.ts || null}`
        );
      }
    };

    this._socket.on('message', safeHandle('message', this._handleMessage));
    this._socket.on('interactive', safeHandle('interactive', this._handleInteractive));
    this._socket.on('reaction_added', safeHandle('reaction_added', this._handleReaction));
    this._socket.on('disconnect', (err) => warn(TAG, `socket disconnected: ${err || 'unknown'}`));
    this._socket.on('error', (err) => logError(TAG, `socket error: ${err?.message || err}`));
    this._socket.on('reconnecting', () => info(TAG, 'socket reconnecting...'));

    await this._socket.start();
    info(TAG, `socket connected, reply_broadcast=${this._replyBroadcast}`);

    this._cleanupInterval = setInterval(() => {
      this._cleanupTrackedThreads();
      cleanImageCache(this._imageCacheDir).catch(() => {});
      const stats = this._threadContext.stats();
      info(TAG, `cleanup: trackedThreads=${stats.trackedThreads} seenMessages=${stats.seenMessages}`);
    }, 30 * 60 * 1000);
  }
}
