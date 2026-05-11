import { join } from 'node:path';
import { info, error as logError, warn } from '../log.js';
import { taskQueue } from '../queue.js';
import { sanitizeErrorText } from '../format-utils.js';
import { storeLesson, storeCorrectionLesson } from '../memory.js';
import { getDefaults } from '../config.js';
import { isUserCorrectionText, writeLessonCandidate } from '../lesson-candidates.js';
import { isSuccessfulStopReason, isTruncatedStopReason } from '../stop-reason.js';
import { ASSISTANT_TEXT_FINAL, CONTROL_PLANE_MESSAGE, METADATA_TITLE, makeTurnId, normalizeChannelSemantics } from '../turn-delivery/intents.js';
import { TurnDeliveryOrchestrator } from '../turn-delivery/orchestrator.js';
import { makeCcEvent, makeTask, validateIncomingIpc } from '../ipc-schema.js';
import { sanitizeTaskForPersistence } from '../scheduler-shutdown-persistence.js';
import { normalizeTaskForSpawn, normalizeOrigin, injectOriginForTask, makeAttemptId } from './task-normalizer.js';
import { abandonTurnState, createTurnState as makeTurnState } from './turn-lifecycle.js';

const TAG = 'scheduler';
const MAX_AUTO_CONTINUE = 2;
const STATUS_REFRESH_MS = 20_000;
const SILENT_PREFIX = '[SILENT]';
const LOADING_MESSAGES = ['Cooking…', 'Reading files…', 'Thinking…', 'Working on it…', 'Analyzing…'];
const THINKING_STATUS = LOADING_MESSAGES[0];

function isSilentResultText(text) { return typeof text === 'string' && text.startsWith(SILENT_PREFIX); }
function shortFailureReason(value, fallback = 'worker failed') {
  const text = sanitizeErrorText(value || fallback).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || fallback;
  return text.length <= 80 ? text : text.slice(0, 77) + '...';
}
function formatJstMonthDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit' }).format(date);
}
function buildFailureReceiptText({ task, threadTs, stopReason, stderrSummary, exitCode }) {
  const reason = shortFailureReason(stderrSummary || stopReason || (exitCode != null ? 'exitCode=' + exitCode : 'worker failed'));
  const cronName = task?.origin?.kind === 'cron' ? task.origin.name : (task?.cronName || (String(threadTs || '').startsWith('cron:') ? String(threadTs).slice('cron:'.length) : ''));
  if (cronName) return `⚠️ ${cronName} ${formatJstMonthDay()}｜失败：LLM｜${reason}`;
  return `:warning: 出错了: ${reason}`;
}
function shouldSuppressForChannelSemantics(channelSemantics, stopReason) { return channelSemantics === 'silent' && isSuccessfulStopReason(stopReason); }
function getTaskCardStreamErrorCode(err) {
  if (!err) return null;
  if (typeof err.slackErrorCode === 'string' && err.slackErrorCode) return err.slackErrorCode;
  const match = String(err.message || '').match(/chat\.(?:start|append|stop)Stream failed: ([a-z_]+)/);
  return match?.[1] || null;
}
function hasReceiptSummary(msg) {
  return Boolean(msg?.dailyNotesSummary?.count > 0 || msg?.gitDiffSummary?.hasChanges);
}
function hasReceiptSummaryInStream(orchestrator, turnId) {
  const records = orchestrator?.ledger?.getRecordsForTurn?.(turnId) || [];
  return records.some((record) => (
    record?.deliveryChannel === 'stream'
    && record?.intent === 'task_progress.stop'
    && (record?.meta?.dailyNotesSummary?.count > 0 || record?.meta?.gitDiffSummary?.hasChanges)
  ));
}
async function emitEphemeralControlPlane({ adapter, channel, threadTs, platform, text, source = 'scheduler.control_plane' }) {
  const orchestrator = new TurnDeliveryOrchestrator({ adapter, logger: (line) => warn(TAG, line) });
  const turnId = makeTurnId({ threadTs, attemptId: `control-${Date.now()}` });
  orchestrator.beginTurn({ turnId, channel, threadTs, platform, channelSemantics: 'reply' });
  return orchestrator.emit({ turnId, channel, threadTs, platform, intent: CONTROL_PLANE_MESSAGE, text, source });
}
function buildRespawnTaskForInjectFailed({ msg, failedTask, task, threadTs, effectiveThreadTs, channel, userId, platform, profile, deferDeliveryUntilResult, channelSemantics }) {
  return {
    ...(failedTask || {}),
    userText: msg.userText ?? failedTask?.userText ?? '',
    fileContent: msg.fileContent ?? failedTask?.fileContent ?? '',
    imagePaths: Array.isArray(msg.imagePaths) ? msg.imagePaths : (failedTask?.imagePaths || []),
    fragments: Array.isArray(msg.fragments) ? msg.fragments : (Array.isArray(failedTask?.fragments) ? failedTask.fragments : []),
    threadTs,
    deliveryThreadTs: failedTask?.deliveryThreadTs === undefined ? effectiveThreadTs : failedTask.deliveryThreadTs,
    channel, userId, platform,
    teamId: failedTask?.teamId ?? task.teamId ?? null,
    threadHistory: failedTask?.threadHistory ?? task.threadHistory,
    profile: failedTask?.profile ?? profile,
    maxTurns: failedTask?.maxTurns ?? task.maxTurns ?? null,
    enableTaskCard: failedTask?.enableTaskCard ?? task.enableTaskCard,
    deferDeliveryUntilResult: failedTask?.deferDeliveryUntilResult ?? deferDeliveryUntilResult,
    channelSemantics: normalizeChannelSemantics(failedTask?.channelSemantics ?? task.channelSemantics ?? channelSemantics),
    attemptId: failedTask?.attemptId ?? msg.attemptId ?? task.attemptId ?? makeAttemptId(),
    origin: normalizeOrigin(failedTask?.origin) || injectOriginForTask(task, task?.attemptId ?? msg.attemptId ?? null),
  };
}
export async function runWorkerForTask(task, { scheduler }) {
    const { userText, fileContent, imagePaths, threadTs, channel, userId, platform } = task;
    const deferDeliveryUntilResult = task.deferDeliveryUntilResult === true;
    const adapter = scheduler._getAdapter(platform);
    if (!adapter && platform !== 'system') {
      logError(TAG, `spawn failed: no adapter for platform=${platform} thread=${threadTs}`);
      task._completion?.reject?.(new Error(`no adapter for platform=${platform}`));
      return;
    }

    // Resolve profile for this user
    let profile;
    let effectiveModel;
    let effectiveEffort;
    let effectiveText;
    try {
      const normalized = normalizeTaskForSpawn(task, {
        getProfile: (targetUserId) => scheduler.getProfile(targetUserId),
        defaults: getDefaults(),
      });
      profile = normalized.profile;
      effectiveModel = normalized.modelEffort.model;
      effectiveEffort = normalized.modelEffort.effort;
      effectiveText = normalized.modelEffort.text;
    } catch (err) {
      logError(TAG, `profile resolution failed for user=${userId}: ${err.message}`);
      await emitEphemeralControlPlane({
        adapter,
        channel,
        threadTs,
        platform,
        text: ':warning: 未识别的用户，无法处理请求。',
        source: 'scheduler.profile_error',
      }).catch(() => {});
      task._completion?.reject?.(err);
      return;
    }
    const channelSemantics = normalizeChannelSemantics(task.channelSemantics);
    info(TAG, `profile resolved: user=${userId} → ${profile.name} (${profile.workspaceDir})`);
    const ledger = scheduler._getTurnDeliveryLedger(profile);
    const orchestrator = new TurnDeliveryOrchestrator({
      adapter,
      ledger,
      logger: (line) => warn(TAG, line),
    });

    let responded = false;
    let userVisibleDeliveryObserved = false;
    let suppressedSuccessObserved = false;
    let pendingAutoContinue = null;
    let effectiveThreadTs = task.deliveryThreadTs === undefined ? (threadTs || null) : task.deliveryThreadTs;
    let turnCount = 0;
    let metadataUpdatedForTurn = false;
    let finalResultText = '';
    let finalStopReason = null;
    let finalErrorSummary = null;
    let workerFailure = null;
    let completionSettled = false;
    let currentCcTurnId = null;
    const toolHistory = [];
    const toolResults = [];
    let worker;
    const canManageThreadStatus = !deferDeliveryUntilResult
      && channel != null
      && typeof adapter?.setThreadStatus === 'function';
    const taskCardConfig = {
      enabled: !deferDeliveryUntilResult
        && platform === 'slack' && channel != null && effectiveThreadTs != null
        && task.enableTaskCard !== false
        && typeof adapter?.startStream === 'function'
        && typeof adapter?.appendStream === 'function'
        && typeof adapter?.stopStream === 'function',
      deferred: deferDeliveryUntilResult
        && platform === 'slack' && channel != null && effectiveThreadTs != null
        && task.enableTaskCard !== false
        && typeof adapter?.startStream === 'function'
        && typeof adapter?.stopStream === 'function',
    };
    let turn = makeTurnState(taskCardConfig);

    const settleCompletion = (method, payload) => {
      if (completionSettled) return;
      completionSettled = true;
      task._completion?.[method]?.(payload);
    };

    const suppressSuccessfulText = (phase, text, stopReason, messageChannelSemantics = channelSemantics) => {
      const effectiveChannelSemantics = normalizeChannelSemantics(messageChannelSemantics);
      if (!shouldSuppressForChannelSemantics(effectiveChannelSemantics, stopReason)) return false;
      const textLength = String(text || '').length;
      info(TAG, `silent ${phase} suppressed: thread=${threadTs} textLen=${textLength}`);
      suppressedSuccessObserved = true;
      return true;
    };

    const clearStatusRefresh = (targetTurn = turn) => {
      if (targetTurn?.statusRefreshTimer) {
        clearTimeout(targetTurn.statusRefreshTimer);
        targetTurn.statusRefreshTimer = null;
      }
    };
    const armStatusRefresh = () => {
      clearStatusRefresh();
      if (!canManageThreadStatus || !effectiveThreadTs) return;
      if (!turn.pendingThreadStatus) return;
      const capturedTurn = turn;
      turn.statusRefreshTimer = setTimeout(async () => {
        capturedTurn.statusRefreshTimer = null;
        if (turn !== capturedTurn || capturedTurn.abandoned) return;
        if (!capturedTurn.pendingThreadStatus || !canManageThreadStatus || !effectiveThreadTs) return;
        try {
          await adapter.setThreadStatus(channel, effectiveThreadTs, capturedTurn.pendingThreadStatus, capturedTurn.pendingStatusLoadingMessages || undefined);
          if (turn !== capturedTurn || capturedTurn.abandoned || !capturedTurn.pendingThreadStatus) {
            await adapter.setThreadStatus(channel, effectiveThreadTs, '', null).catch(() => {});
            return;
          }
          armStatusRefresh();
        } catch (err) {
          warn(TAG, `status refresh failed: ${err.message}`);
        }
      }, STATUS_REFRESH_MS);
    };

    const applyThreadStatus = async (status, loadingMessages) => {
      turn.pendingThreadStatus = String(status || '');
      turn.pendingStatusLoadingMessages = Array.isArray(loadingMessages) ? loadingMessages : null;
      if (!canManageThreadStatus || !effectiveThreadTs) return;
      try {
        await adapter.setThreadStatus(channel, effectiveThreadTs, turn.pendingThreadStatus, loadingMessages);
        if (turn.pendingThreadStatus) armStatusRefresh();
        else clearStatusRefresh();
      } catch (err) {
        warn(TAG, `failed to set thread status: ${err.message}`);
        clearStatusRefresh();
      }
    };

    const startThreadStatusRefresh = async (status = THINKING_STATUS) => {
      if (!canManageThreadStatus) return;
      await applyThreadStatus(status, LOADING_MESSAGES);
    };

    const startTyping = async () => {
      if (deferDeliveryUntilResult) return;
      await startThreadStatusRefresh();
      turn.typingActive = true;
    };

    const stopTyping = async () => {
      if (deferDeliveryUntilResult) return;
      if (!turn.typingActive) return;
      turn.typingActive = false;
      await applyThreadStatus('');
    };

    const abandonTurn = async (prevTurn) => {
      if (!prevTurn || prevTurn.abandoned) return;
      clearStatusRefresh(prevTurn);
      for (const key of [...scheduler._pendingPermissionRequests.keys()]) {
        if (key.startsWith(`${threadTs}:`)) {
          scheduler._resolvePermissionRequest(key, { allow: false, reason: 'turn abandoned' });
        }
      }
      await abandonTurnState({
        turn: prevTurn,
        adapter,
        channel,
        threadTs: effectiveThreadTs,
        canManageThreadStatus: canManageThreadStatus && effectiveThreadTs != null,
      });
    };

    const resetTaskCardState = () => {
      for (const taskCardState of Object.values(turn.taskCardStates || {})) {
        taskCardState.streamId = null;
        taskCardState.failed = false;
      }
    };

    const finalizeStreamsOnAbnormalExit = async () => {
      try {
        if (channel != null && effectiveThreadTs != null && !userVisibleDeliveryObserved) {
          await orchestrator.emit({
            turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
            attemptId: task.attemptId || '',
            channel,
            threadTs: effectiveThreadTs,
            platform,
            channelSemantics,
            intent: CONTROL_PLANE_MESSAGE,
            text: '⚠️ 本轮任务异常终止（worker timeout 或 crash），可发「继续」让我从失败点续做。',
            source: 'scheduler.abnormal_exit',
          });
          userVisibleDeliveryObserved = true;
        }
      } catch (err) {
        warn(TAG, `failed to send worker abnormal-exit notice: ${err.message}`);
      } finally {
        resetTaskCardState();
      }
    };

    const updateThreadMetadata = async (text) => {
      if (metadataUpdatedForTurn) return;
      if (platform !== 'slack' || !channel || !effectiveThreadTs || !text) return;
      metadataUpdatedForTurn = true;
      if (turnCount === 0) {
        await orchestrator.emit({
          turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
          attemptId: task.attemptId || '',
          channel,
          threadTs: effectiveThreadTs,
          platform,
          channelSemantics,
          intent: METADATA_TITLE,
          text,
          source: 'scheduler.metadata',
        }).catch((err) => warn(TAG, `metadata delivery failed: ${err.message}`));
      }
      turnCount += 1;
    };

    const emitAssistantFinal = async ({ text, msg = null, source, meta = {}, channelSemanticsOverride = null }) => {
      if (!String(text || '').trim()) return { delivered: false, reason: 'empty-final' };
      const result = await orchestrator.emit({
        turnId: makeTurnId({ turnId: msg?.turnId || currentCcTurnId, threadTs, attemptId: msg?.attemptId || task.attemptId }),
        attemptId: msg?.attemptId || task.attemptId || '',
        channel,
        threadTs: effectiveThreadTs,
        platform,
        channelSemantics: normalizeChannelSemantics(channelSemanticsOverride ?? msg?.channelSemantics ?? channelSemantics),
        intent: ASSISTANT_TEXT_FINAL,
        text,
        source,
        meta,
      });
      if (result.delivered) userVisibleDeliveryObserved = true;
      return result;
    };

    const emitReceiptContextFallback = async ({ msg, source, meta = {} }) => {
      if (!hasReceiptSummary(msg)) return { delivered: false, reason: 'no-receipt-summary' };
      const turnId = makeTurnId({ turnId: msg?.turnId || currentCcTurnId, threadTs, attemptId: msg?.attemptId || task.attemptId });
      if (hasReceiptSummaryInStream(orchestrator, turnId)) {
        return { delivered: false, reason: 'receipt-summary-already-streamed' };
      }
      const result = await orchestrator.emit({
        turnId,
        attemptId: msg?.attemptId || task.attemptId || '',
        channel,
        threadTs: effectiveThreadTs,
        platform,
        channelSemantics: normalizeChannelSemantics(msg?.channelSemantics ?? channelSemantics),
        intent: ASSISTANT_TEXT_FINAL,
        text: '',
        source,
        meta: {
          ...meta,
          gitDiffSummary: msg.gitDiffSummary || null,
          dailyNotesSummary: msg.dailyNotesSummary || null,
          contextOnly: true,
        },
      });
      if (result.delivered) userVisibleDeliveryObserved = true;
      return result;
    };

    const handleExitResult = async (msg) => {
      const text = '';
      finalResultText = '';
      finalStopReason = msg.stopReason || finalStopReason;
      finalErrorSummary = msg.stderrSummary || finalErrorSummary;

      try {
        if (!isSuccessfulStopReason(msg.stopReason)) {
          scheduler._autoContinueCount.delete(threadTs);
          const isMaxTurnsLike = isTruncatedStopReason(msg.stopReason);
          if (isMaxTurnsLike) {
            warn(TAG, `worker turn limit result: thread=${threadTs} stopReason=${msg.stopReason} exitCode=${msg.exitCode ?? 'unknown'}`);
            if (!userVisibleDeliveryObserved) {
              const turns = task.maxTurns || 'configured';
              const notice = msg.stopReason === 'tool_use'
                ? `⏳ LLM 在工具调用中触达 turn 上限（${turns} turn）。任务未完成，可发「继续」让我从此处续做。`
                : '⏳ 触达 turn 上限。任务未完成，可发「继续」让我从此处续做。';
              const result = await orchestrator.emit({
                turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
                attemptId: task.attemptId || '',
                channel,
                threadTs: effectiveThreadTs,
                platform,
                channelSemantics: 'reply',
                intent: CONTROL_PLANE_MESSAGE,
                text: notice,
                source: 'scheduler.turn_limit',
                meta: {
                  stopReason: msg.stopReason,
                  exitCode: msg.exitCode ?? null,
                },
              });
              if (result.delivered) userVisibleDeliveryObserved = true;
            }
            return;
          }
          const receiptText = buildFailureReceiptText({
            task,
            threadTs,
            stopReason: msg.stopReason,
            stderrSummary: msg.stderrSummary,
            exitCode: msg.exitCode,
          });
          warn(TAG, `worker non-success result: thread=${threadTs} stopReason=${msg.stopReason || 'unknown'} exitCode=${msg.exitCode ?? 'unknown'}`);
          if (!userVisibleDeliveryObserved) {
            const result = await orchestrator.emit({
              turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
              attemptId: task.attemptId || '',
              channel,
              threadTs: effectiveThreadTs,
              platform,
              channelSemantics: 'reply',
              intent: CONTROL_PLANE_MESSAGE,
              text: receiptText,
              source: 'scheduler.result_failure',
              meta: {
                stopReason: msg.stopReason || null,
                exitCode: msg.exitCode ?? null,
              },
            });
            if (result.delivered) userVisibleDeliveryObserved = true;
          }
          return;
        }

        // Exit signal: empty text after turn_complete delivery is expected and
        // should not enter auto-continue or fallback delivery.
        if (userVisibleDeliveryObserved || suppressedSuccessObserved) {
          scheduler._autoContinueCount.delete(threadTs);
          return;
        }

        const isMaxTurnsReached = msg.stopReason === 'max_turns_reached';
        const isToolOnlyCompletion = !isMaxTurnsReached && (msg.toolCount || 0) > 0;

        // tool-only turn（如 GitHub 调研卡片流）：最后一个 turn 只有 tool_use、
        // 外投通过 Bash → Slack API 完成，没有 assistant text。这是预期的正常结束，
        // 不应触发 auto-continue 也不应发提示。
        if (isToolOnlyCompletion) {
          info(TAG, `tool-only turn completed without text, skipping auto-continue: thread=${threadTs} toolCount=${msg.toolCount} lastTool=${msg.lastTool || 'none'}`);
          scheduler._autoContinueCount.delete(threadTs);
          return;
        }

        const retries = scheduler._autoContinueCount.get(threadTs) || 0;
        if (retries < MAX_AUTO_CONTINUE) {
          scheduler._autoContinueCount.set(threadTs, retries + 1);
          const reasonTag = isMaxTurnsReached ? 'max_turns_reached' : 'empty';
          warn(TAG, `${reasonTag} result, auto-continue ${retries + 1}/${MAX_AUTO_CONTINUE} for thread=${threadTs}`);
          const suppressAutoContinueNotice = platform === 'slack'
            && typeof channel === 'string'
            && channel.startsWith('D');
          if (!deferDeliveryUntilResult && !suppressAutoContinueNotice) {
            const notice = isMaxTurnsReached
              ? `⏳ 到达回合上限，自动续接中 (${retries + 1}/${MAX_AUTO_CONTINUE})…`
              : `⏳ 本轮无输出，自动续接中 (${retries + 1}/${MAX_AUTO_CONTINUE})…`;
            await orchestrator.emit({
              turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
              attemptId: task.attemptId || '',
              channel,
              threadTs: effectiveThreadTs,
              platform,
              channelSemantics,
              intent: CONTROL_PLANE_MESSAGE,
              text: notice,
              source: 'scheduler.auto_continue',
            }).catch(() => {});
          } else if (suppressAutoContinueNotice) {
            info(TAG, `${reasonTag} result auto-continue notice suppressed in Slack DM: thread=${threadTs}`);
          }
          // Defer submit to onExit — avoid race with worker's process.exit(0)
          pendingAutoContinue = {
            userText: '继续',
            fileContent: '',
            imagePaths: [],
            threadTs,
            deliveryThreadTs: effectiveThreadTs,
            channel,
            userId,
            platform,
            teamId: task.teamId || null,
            attemptId: task.attemptId,
            threadHistory: task.threadHistory,
            fragments: task.fragments || [],
            profile,
            maxTurns: task.maxTurns || null,
            enableTaskCard: task.enableTaskCard,
            deferDeliveryUntilResult,
            channelSemantics,
            origin: task.origin,
            _autoContinue: true,
            _completion: task._completion,
          };
          return;
        }
        warn(TAG, `empty result after ${MAX_AUTO_CONTINUE} auto-continues for thread=${threadTs}`);
        scheduler._autoContinueCount.delete(threadTs);

        // Fallback delivery remains here only for exit-only completions that
        // never reached turn_complete. result.text is intentionally ignored.
        if (!userVisibleDeliveryObserved) {
          const finalText = '⚠️ 多次续接仍未生成回复，任务可能需要拆分。请用更小的指令重试。';
          await emitAssistantFinal({
            text: finalText,
            msg,
            source: 'scheduler.result',
            meta: { stopReason: msg.stopReason || null },
          });
          userVisibleDeliveryObserved = true;
        }

        resetTaskCardState();
        await updateThreadMetadata(text);

        if (text) {
          const errorPatterns = /(?:error|failed|permission denied|ENOENT|not found|timed?\s*out|EACCES)/i;
          if (errorPatterns.test(text) && text.length > 50) {
            storeLesson({
              userText: task.userText || '',
              errorText: '',
              responseText: text.slice(0, 2000),
              threadTs,
              userId,
              dbPath: join(profile.dataDir, 'memory.db'),
            }).catch(() => {});
          }
        }
        if (isUserCorrectionText(task.userText)) {
          storeCorrectionLesson({
            userText: task.userText || '',
            responseText: (text || '').slice(0, 2000),
            threadHistory: (task.threadHistory || '').slice(0, 3000),
            threadTs,
            userId,
            dbPath: join(profile.dataDir, 'memory.db'),
          }).catch(() => {});
          try {
            writeLessonCandidate(profile.dataDir, {
              source: 'user-correction',
              stopReason: 'user correction keyword',
              errorContext: JSON.stringify({
                userText: task.userText || '',
                previousTurnSummary: (text || '').slice(0, 500),
                origin: task.origin,
              }).slice(0, 1000),
              threadId: threadTs,
              kind: 'user',
              origin: task.origin,
            });
          } catch (candidateErr) {
            warn(TAG, `failed to write user-correction lesson candidate: ${candidateErr.message}`);
          }
        }
      } catch (err) {
        const errCode = typeof getTaskCardStreamErrorCode === 'function' ? getTaskCardStreamErrorCode(err) : null;
        logError(TAG, `failed to send result: ${err.message}${errCode ? ` (code=${errCode})` : ''}`);
        await orchestrator.emit({
          turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
          attemptId: task.attemptId || '',
          channel,
          threadTs: effectiveThreadTs,
          platform,
          channelSemantics,
          intent: CONTROL_PLANE_MESSAGE,
          text: ':warning: 回复发送失败。',
          source: 'scheduler.result_error',
        }).catch(() => {});
      }

      if (msg.toolCount > 0) {
        try { scheduler._checkSkillReview(profile.name, msg.toolCount, task, text, toolHistory, toolResults); } catch (_) {}
        try { scheduler._checkMemorySync(profile.name, msg.toolCount, task); } catch (_) {}
      }
    };

    try {
      ({ worker } = scheduler._spawnWorkerFn({
        task: makeTask({
          userText: effectiveText,
          fileContent,
          imagePaths: imagePaths || [],
          threadTs,
          channel,
          userId,
          platform,
          teamId: task.teamId || null,
          attemptId: task.attemptId,
          channelSemantics,
          origin: task.origin,
          threadHistory: task.threadHistory,
          model: effectiveModel,
          effort: effectiveEffort,
          maxTurns: task.maxTurns || null,
          fragments: task.fragments || [],
          profile: {
            name: profile.name,
            scriptsDir: profile.scriptsDir,
            workspaceDir: profile.workspaceDir,
            dataDir: profile.dataDir,
          },
        }),
        timeout: scheduler.timeoutMs,
        label: threadTs,
        onMessage: async (msg) => {
          // Worker IPC is now lifecycle + event-stream only:
          // turn_start, turn_end, turn_complete, cc_event, inject_failed,
          // error, and the process-exit result signal. Slack UI rendering is
          // driven by cc_event subscribers; legacy UI IPC handlers were removed.
          const validationError = validateIncomingIpc(msg);
          if (validationError) {
            warn(TAG, `dropped invalid worker ipc: ${validationError} thread=${threadTs}`);
            return;
          }
          info(TAG, `worker response: type=${msg.type} thread=${threadTs} textLen=${msg.text?.length || 0}`);

          if (msg.type === 'cc_event') {
            currentCcTurnId = msg.turnId || currentCcTurnId;
            if (msg.eventType === 'tool_use') {
              toolHistory.push({
                name: msg.payload?.name || null,
                input: msg.payload?.input || msg.payload || {},
              });
            } else if (msg.eventType === 'tool_result') {
              toolResults.push(msg.payload || {});
            }
            try {
              await scheduler._publishWorkerCcEvent(msg, {
                task,
                turn,
                worker,
                adapter,
                channel,
                threadTs,
                effectiveThreadTs,
                platform,
                profile,
                deferDeliveryUntilResult,
                channelSemantics,
                applyThreadStatus,
                orchestrator,
              });
            } catch (err) {
              warn(TAG, `eventBus publish failed: ${err.message}`);
            }
            return;
          }
          if (msg.type === 'inject_failed') {
            responded = true;
            const activeEntry = scheduler.activeWorkers.get(threadTs);
            const failedTask = activeEntry?.pendingInjects?.get(msg.injectId) || null;
            try {
              writeLessonCandidate(profile.dataDir, {
                source: 'inject-failed',
                stopReason: 'inject_failed',
                errorContext: JSON.stringify({
                  userText: msg.userText || '',
                  injectId: msg.injectId || null,
                  origin: failedTask?.origin || msg.origin || null,
                }).slice(0, 500),
                threadId: threadTs,
                kind: 'inject',
                origin: failedTask?.origin || msg.origin || null,
              });
            } catch (err) {
              warn(TAG, `failed to write inject_failed lesson candidate: ${err.message}`);
            }
            if (activeEntry?.pendingInjects && msg.injectId) {
              activeEntry.pendingInjects.delete(msg.injectId);
            }
            const respawnTask = buildRespawnTaskForInjectFailed({
              msg,
              failedTask,
              task,
              threadTs,
              effectiveThreadTs,
              channel,
              userId,
              platform,
              profile,
              deferDeliveryUntilResult,
              channelSemantics,
            });
            if (!scheduler.threadQueues.has(threadTs)) scheduler.threadQueues.set(threadTs, []);
            scheduler.threadQueues.get(threadTs).unshift(respawnTask);
            await abandonTurn(turn);
            turn = makeTurnState(taskCardConfig);
            try {
              activeEntry?.worker?.kill?.('SIGTERM');
            } catch (err) {
              warn(TAG, `inject_failed kill worker failed: ${err.message}`);
            }
            warn(TAG, `inject failed, respawning worker for thread=${threadTs}`);
            return;
          }

          if (msg.type === 'turn_start') {
            if (msg.injectId) {
              const activeEntry = scheduler.activeWorkers.get(threadTs);
              activeEntry?.pendingInjects?.delete(msg.injectId);
            }
            await abandonTurn(turn);
            turn = makeTurnState(taskCardConfig);
            userVisibleDeliveryObserved = false;
            suppressedSuccessObserved = false;
            currentCcTurnId = makeTurnId({ turnId: msg.turnId, threadTs, attemptId: msg.attemptId || task.attemptId });
            orchestrator.beginTurn({
              turnId: currentCcTurnId,
              attemptId: msg.attemptId || task.attemptId || '',
              channel,
              threadTs: effectiveThreadTs,
              platform,
              channelSemantics: normalizeChannelSemantics(msg.channelSemantics ?? channelSemantics),
              taskCardStates: turn.taskCardStates,
            });
            metadataUpdatedForTurn = false;
            await startTyping();
            return;
          }

          if (msg.type === 'turn_end') {
            await stopTyping();
            responded = true;
            return;
          }

          responded = true;

          if (msg.type === 'turn_complete') {
            finalStopReason = msg.stopReason || finalStopReason;
            if (msg.channelSemantics === 'silent' && isSuccessfulStopReason(msg.stopReason)) {
              suppressedSuccessObserved = true;
            }
            await stopTyping();
            const deliveryText = typeof msg?.text === 'string' ? msg.text : '';
            const metadataText = deliveryText;
            try {
              if (deliveryText.trim() && suppressSuccessfulText('turn_complete', deliveryText, msg.stopReason, msg.channelSemantics)) {
                await emitAssistantFinal({
                  text: deliveryText,
                  msg,
                  source: 'scheduler.turn_complete',
                  meta: { stopReason: msg.stopReason || null },
                });
                resetTaskCardState();
                return;
              }
              if (deferDeliveryUntilResult && isSilentResultText(deliveryText)) {
                info(TAG, `silent deferred turn suppressed: thread=${threadTs}`);
                suppressedSuccessObserved = true;
                await emitAssistantFinal({
                  text: deliveryText,
                  msg,
                  source: 'scheduler.turn_complete',
                  meta: { stopReason: msg.stopReason || null, deferred: true },
                  channelSemanticsOverride: 'silent',
                });
                resetTaskCardState();
                return;
              }
              if (deliveryText.trim()) {
                await emitAssistantFinal({
                  text: deliveryText,
                  msg,
                  source: 'scheduler.turn_complete',
                  meta: {
                    gitDiffSummary: msg.gitDiffSummary || null,
                    dailyNotesSummary: msg.dailyNotesSummary || null,
                    deferred: deferDeliveryUntilResult,
                  },
                });
              } else if (hasReceiptSummary(msg)) {
                await emitReceiptContextFallback({
                  msg,
                  source: 'scheduler.turn_complete.context_only',
                  meta: { stopReason: msg.stopReason || null, deferred: deferDeliveryUntilResult },
                });
              } else if (metadataText?.trim()) {
                userVisibleDeliveryObserved = true;
                info(TAG, `turn_complete text already delivered`);
              }
              await updateThreadMetadata(metadataText);
              resetTaskCardState();
            } catch (err) {
              logError(TAG, `failed to send turn_complete: ${err.message}`);
              const fallbackText = deliveryText;
              const silentDeferredFallback = deferDeliveryUntilResult && isSilentResultText(fallbackText);
              if (silentDeferredFallback) {
                info(TAG, `silent deferred turn suppressed after delivery failure: thread=${threadTs}`);
                suppressedSuccessObserved = true;
                await emitAssistantFinal({
                  text: fallbackText,
                  msg,
                  source: 'scheduler.fallback',
                  meta: { stopReason: msg.stopReason || null, deferred: true },
                  channelSemanticsOverride: 'silent',
                });
              } else if (fallbackText.trim()) {
                await emitAssistantFinal({
                  text: fallbackText,
                  msg,
                  source: 'scheduler.fallback',
                  meta: {
                    gitDiffSummary: msg.gitDiffSummary || null,
                    dailyNotesSummary: msg.dailyNotesSummary || null,
                    deferred: deferDeliveryUntilResult,
                  },
                });
              } else if (hasReceiptSummary(msg)) {
                await emitReceiptContextFallback({
                  msg,
                  source: 'scheduler.fallback.context_only',
                  meta: { stopReason: msg.stopReason || null, deferred: deferDeliveryUntilResult },
                });
              } else if (metadataText?.trim()) {
                userVisibleDeliveryObserved = true;
                info(TAG, `turn_complete fallback text already delivered`);
              }
              if (!silentDeferredFallback) await updateThreadMetadata(metadataText);
              resetTaskCardState();
            }
            return;
          }

          if (msg.type === 'result') {
            await handleExitResult(msg);
          } else if (msg.type === 'error') {
            const safeError = sanitizeErrorText(msg.error || '未知错误');
            workerFailure = new Error(safeError);
            logError(TAG, `worker error for thread=${threadTs}: ${safeError}`);
            try {
              writeLessonCandidate(profile.dataDir, {
                source: 'worker-error',
                stopReason: safeError,
                errorContext: JSON.stringify({ ...(msg.errorContext || {}), origin: task.origin }).slice(0, 500),
                threadId: threadTs,
                kind: 'worker',
                origin: task.origin,
              });
            } catch (err) {
              warn(TAG, `failed to write worker-error lesson candidate: ${err.message}`);
            }
            await stopTyping();
            await orchestrator.emit({
              turnId: currentCcTurnId || makeTurnId({ threadTs, attemptId: task.attemptId }),
              attemptId: task.attemptId || '',
              channel,
              threadTs: effectiveThreadTs,
              platform,
              channelSemantics: 'reply',
              intent: CONTROL_PLANE_MESSAGE,
              text: `:warning: 出错了: ${safeError}`,
              source: 'scheduler.worker_error',
            }).catch(() => {});
            storeLesson({
              userText: msg.errorContext?.userText || '',
              errorText: msg.error || '',
              responseText: '',
              threadTs,
              userId,
              dbPath: join(profile.dataDir, 'memory.db'),
            }).catch(() => {});
          }
        },
        onExit: async (code, signal) => {
          await stopTyping();
          await applyThreadStatus('');
          adapter?.clearStatusByContext?.({ channel, threadTs: effectiveThreadTs });
          if (currentCcTurnId) {
            try {
              await scheduler._publishWorkerCcEvent(makeCcEvent({
                eventType: 'turn_abort',
                turnId: currentCcTurnId,
                origin: task.origin,
                payload: { synthetic: true },
              }), {
                task,
                turn,
                worker,
                adapter,
                channel,
                threadTs,
                effectiveThreadTs,
                platform,
                profile,
                deferDeliveryUntilResult,
                channelSemantics,
                applyThreadStatus,
                orchestrator,
              });
            } catch (err) {
              warn(TAG, `eventBus turn_abort publish failed: ${err.message}`);
            }
          }
          scheduler.activeWorkers.delete(threadTs);

          const next = taskQueue.dequeue();
          if (next) {
            info(TAG, `draining queue: thread=${next.threadTs} waited=${Date.now() - next.enqueuedAt}ms`);
            await scheduler.submit(next);
          }

          info(TAG, `worker exited: pid=${worker.pid} code=${code} signal=${signal} responded=${responded} thread=${threadTs}`);

          const deliveredBeforeExitNotice = userVisibleDeliveryObserved
            || Boolean(currentCcTurnId && orchestrator.hasUserVisibleDelivery(currentCcTurnId));
          const abnormalExit = !responded && (signal !== null || (code !== 0 && code !== null));
          if (abnormalExit) {
            await finalizeStreamsOnAbnormalExit();
          }

          if (!responded && !deliveredBeforeExitNotice) {
            logError(TAG, `worker exited without response: thread=${threadTs} code=${code} signal=${signal}`);
            scheduler._autoContinueCount.delete(threadTs);
            await adapter.cleanupIndicator(channel, effectiveThreadTs, false, '处理过程中出错，请重试。');
          } else if (!responded) {
            warn(TAG, `worker exited without IPC signal but stream delivered: thread=${threadTs} (suppressed user-facing warning)`);
            scheduler._autoContinueCount.delete(threadTs);
          }

          await scheduler.processNextQueued(threadTs);

          if (pendingAutoContinue) {
            const cont = pendingAutoContinue;
            pendingAutoContinue = null;
            info(TAG, `auto-continue dispatched after worker exit: thread=${cont.threadTs}`);
            await scheduler.submit(cont);
            return;
          }

          if (workerFailure) {
            settleCompletion('reject', workerFailure);
          } else if (!responded) {
            settleCompletion('reject', new Error(signal ? `worker killed: ${signal}` : `worker exited with code ${code}`));
          } else {
            settleCompletion('resolve', {
              text: finalResultText,
              threadTs: effectiveThreadTs,
              stopReason: finalStopReason,
              errorSummary: finalErrorSummary,
            });
          }
        },
      }));
    } catch (err) {
      logError(TAG, `fork failed: ${err.message}`);
      await stopTyping();
      await adapter.cleanupIndicator(channel, effectiveThreadTs, false, 'Worker 启动失败。');
      await scheduler.processNextQueued(threadTs);
      settleCompletion('reject', err);
      return;
    }

    scheduler.activeWorkers.set(threadTs, {
      worker,
      platform,
      channel,
      userId,
      deliveryThreadTs: effectiveThreadTs,
      channelSemantics,
      pendingInjects: new Map(),
      task: sanitizeTaskForPersistence(task),
      orchestrator,
      ledger,
    });
    worker.on('error', (err) => {
      logError(TAG, `worker error event: pid=${worker.pid} err=${err.message}`);
    });
    info(TAG, `task sent to worker pid=${worker.pid} thread=${threadTs} profile=${profile.name}`);
  }
