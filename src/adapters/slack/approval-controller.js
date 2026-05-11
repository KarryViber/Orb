import { error as logError, warn } from '../../log.js';
import { markdownToMrkdwn } from '../slack-format.js';
import {
  dispatchBlockActionHandler,
  handleBlockActionMessageChanged,
  ORB_RESERVED_ACTION_IDS,
  releaseBlockActionMessage,
  updateBlockActionCard,
} from '../slack-block-actions.js';
import { formatSlackInlineCode, renderPermissionSemantics } from '../slack-permission-render.js';

const TAG = 'slack';

export function createApprovalController({
  webClient,
  getProfilePaths,
  resolveLedger,
}) {
  const pendingApprovals = new Map();
  const blockActionInFlight = new Set();

  const controller = {
    _pendingApprovals: pendingApprovals,
    _blockActionInFlight: blockActionInFlight,

    _buildApprovalBlocks(prompt, approvalId) {
      if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
        return controller._buildPermissionApprovalBlocks(prompt, approvalId);
      }
      return [
        { type: 'section', text: { type: 'mrkdwn', text: markdownToMrkdwn(String(prompt || '')) } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Allow Once', emoji: true },
            style: 'primary', action_id: 'orb_approve_once', value: approvalId },
          { type: 'button', text: { type: 'plain_text', text: 'Allow Session', emoji: true },
            action_id: 'orb_approve_session', value: approvalId },
          { type: 'button', text: { type: 'plain_text', text: 'Always Allow', emoji: true },
            action_id: 'orb_approve_always', value: approvalId },
          { type: 'button', text: { type: 'plain_text', text: 'Deny', emoji: true },
            style: 'danger', action_id: 'orb_deny', value: approvalId },
        ]},
      ];
    },

    _buildPermissionApprovalBlocks(prompt, approvalId) {
      const timeoutSeconds = Math.round((prompt.timeoutMs || 300_000) / 1000);
      const timeoutLabel = timeoutSeconds % 60 === 0
        ? `${Math.max(1, Math.round(timeoutSeconds / 60))} 分钟内处理`
        : `${timeoutSeconds}s 内处理`;
      const semantics = renderPermissionSemantics(prompt.toolName, prompt.toolInput);
      const debugSummary = [
        `tool=\`${prompt.toolName || 'unknown'}\``,
        `request=\`${prompt.requestId || 'unknown'}\``,
        `thread=\`${prompt.threadTs || 'unknown'}\``,
      ].join(' · ');
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: '*🔐 权限请求*' } },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${semantics.emoji} ${semantics.action}*\n${formatSlackInlineCode(semantics.targetValue)}`,
          },
        },
      ];

      if (semantics.previewTitle && semantics.previewBody) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${semantics.previewTitle}*\n${semantics.previewBody}${semantics.previewMeta ? `\n${semantics.previewMeta}` : ''}`,
          },
        });
      }

      blocks.push(
        { type: 'context', elements: [{ type: 'mrkdwn', text: `⏰ ${timeoutLabel}，超时自动拒绝` }] },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `调试: ${debugSummary}` },
            { type: 'mrkdwn', text: `raw: ${formatSlackInlineCode(controller._truncateForSlackCodeBlock(semantics.rawInput || prompt.toolInput, 180))}` },
          ],
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '允许', emoji: true }, style: 'primary', action_id: 'orb_approve_once', value: approvalId },
            { type: 'button', text: { type: 'plain_text', text: '拒绝', emoji: true }, style: 'danger', action_id: 'orb_deny', value: approvalId },
          ],
        },
      );
      return blocks;
    },

    _truncateForSlackCodeBlock(value, maxChars) {
      let text;
      try {
        text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
      const normalized = (text || '').replace(/```/g, '` ` `');
      if (normalized.length <= maxChars) return normalized;
      return `${normalized.slice(0, maxChars - 3)}...`;
    },

    _approvalFallbackText(prompt) {
      if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
        return `权限请求: ${prompt.toolName || 'unknown'}`;
      }
      return markdownToMrkdwn(`承認リクエスト: ${String(prompt || '').slice(0, 100)}`);
    },

    _approvalTimeoutReason(prompt) {
      if (prompt && typeof prompt === 'object' && prompt.kind === 'permission') {
        const seconds = Math.round((prompt.timeoutMs || 300_000) / 1000);
        return `timeout: no response from Slack approval in ${seconds}s`;
      }
      return 'timeout';
    },

    _buildApprovalStatusBlocks(pending, label, extraText) {
      const toolName = pending?.prompt?.toolName || '';
      const semantics = toolName ? ` · \`${toolName}\`` : '';
      const trailing = extraText ? ` · ${extraText}` : '';
      return [{ type: 'context', elements: [{ type: 'mrkdwn', text: `${label}${semantics}${trailing}` }] }];
    },

    async sendApproval(channel, threadTs, prompt) {
      const effectivePrompt = (prompt && typeof prompt === 'object') ? { ...prompt, threadTs, channel } : prompt;
      const approvalId = `${threadTs}_${Date.now()}`;
      const blocks = controller._buildApprovalBlocks(effectivePrompt, approvalId);
      const timeoutMs = (effectivePrompt && typeof effectivePrompt === 'object' && effectivePrompt.timeoutMs)
        ? effectivePrompt.timeoutMs
        : 10 * 60 * 1000;

      const msg = await webClient.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks,
        text: controller._approvalFallbackText(effectivePrompt),
      });
      const ledger = resolveLedger(effectivePrompt);
      try {
        ledger?.recordAdapterEvent({
          source: 'slack.sendApproval',
          eventType: 'adapter.approval.created',
          channel,
          ts: msg.ts,
          platform: 'slack',
          meta: { approvalId, kind: effectivePrompt?.kind },
        });
      } catch (err) {
        warn(TAG, `ledger record failed: ${err.message}`);
      }
      return new Promise((resolve) => {
        const timeoutHandle = setTimeout(() => {
          if (pendingApprovals.has(approvalId)) {
            const pending = pendingApprovals.get(approvalId);
            pendingApprovals.delete(approvalId);
            const reason = controller._approvalTimeoutReason(effectivePrompt);
            const label = effectivePrompt?.kind === 'permission' ? '⏰ 超时自动拒绝' : '⏰ Timed Out';
            webClient.chat.update({
              channel,
              ts: msg.ts,
              blocks: controller._buildApprovalStatusBlocks(pending, label, reason),
              text: label,
            }).then((updated) => {
              try {
                pending.ledger?.recordAdapterEvent({
                  source: 'slack.sendApproval.timeout',
                  eventType: 'adapter.approval.timeout',
                  channel,
                  ts: updated?.ts || msg.ts,
                  platform: 'slack',
                  meta: { approvalId, kind: effectivePrompt?.kind, reason },
                });
              } catch (err) {
                warn(TAG, `ledger record failed: ${err.message}`);
              }
            }).catch((err) => {
              logError(TAG, `failed to update timed out approval: ${err.message}`);
            });
            resolve({ approved: false, reason, scope: 'once' });
          }
        }, timeoutMs);

        pendingApprovals.set(approvalId, {
          resolve,
          channel,
          threadTs,
          messageTs: msg.ts,
          timeoutHandle,
          prompt: effectivePrompt,
          blocks,
          ledger,
        });
      });
    },

    async _handleInteractive({ body, ack }) {
      try { await ack(); } catch (_) {}
      if (body.type !== 'block_actions' || !body.actions?.length) return;

      const action = body.actions[0];
      const approvalId = action.value;
      const actionId = action.id || action.action_id;
      const userId = body.user?.id;

      if (approvalId && pendingApprovals.has(approvalId)) {
        const pending = pendingApprovals.get(approvalId);
        pendingApprovals.delete(approvalId);
        clearTimeout(pending.timeoutHandle);

        const approvalMap = {
          orb_approve_once: { approved: true, scope: 'once', label: '✅ Allowed Once' },
          orb_approve_session: { approved: true, scope: 'session', label: '✅ Allowed (Session)' },
          orb_approve_always: { approved: true, scope: 'always', label: '✅ Always Allowed' },
          orb_deny: { approved: false, scope: 'once', label: '❌ Denied' },
        };
        const { approved, scope, label } = approvalMap[actionId] || { approved: false, scope: 'once', label: '❌ Denied' };

        try {
          await webClient.chat.update({
            channel: pending.channel,
            ts: pending.messageTs,
            blocks: controller._buildApprovalStatusBlocks(pending, label, `by <@${userId}>`),
            text: label,
          });
          try {
            pending.ledger?.recordAdapterEvent({
              source: 'slack.block_action',
              eventType: 'adapter.approval.resolved',
              channel: pending.channel,
              ts: pending.messageTs,
              platform: 'slack',
              meta: { approvalId, approved, scope, userId },
            });
          } catch (err) {
            warn(TAG, `ledger record failed: ${err.message}`);
          }
        } catch (err) {
          logError(TAG, `failed to update approval message: ${err.message}`);
        }

        pending.resolve({ approved, scope, userId });
        return;
      }

      if (ORB_RESERVED_ACTION_IDS.has(actionId)) {
        warn(TAG, `orb approval miss (likely daemon restart / timeout): actionId=${actionId} approvalId=${approvalId}`);
        const channel = body.channel?.id || body.container?.channel_id;
        const messageTs = body.message?.ts || body.container?.message_ts;
        try {
          await webClient.chat.update({
            channel,
            ts: messageTs,
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '⏰ 此权限请求已过期或因 daemon 重启失效，请重新触发对应动作。' },
              },
            ],
            text: '权限请求已失效',
          });
          try {
            resolveLedger?.({ userId })?.recordAdapterEvent?.({
              source: 'slack.block_action',
              eventType: 'adapter.approval.missing',
              channel,
              ts: messageTs,
              platform: 'slack',
              meta: { approvalId, actionId, userId },
            });
          } catch (err) {
            warn(TAG, `ledger record failed: ${err.message}`);
          }
        } catch (err) {
          logError(TAG, `failed to update stale approval card: ${err.message}`);
        }
        return;
      }

      await dispatchBlockActionHandler({
        body,
        action,
        actionId,
        slack: webClient,
        getProfilePaths,
        resolveLedger,
        inFlight: blockActionInFlight,
      });
    },

    _releaseBlockActionMessage(messageTs) {
      releaseBlockActionMessage(blockActionInFlight, messageTs);
    },

    _handleMessageChanged(event) {
      handleBlockActionMessageChanged(event, blockActionInFlight);
    },

    async _updateBlockActionCard(channel, messageTs, text, originalBlocks = null, ledgerHint = {}) {
      return updateBlockActionCard({
        slack: webClient,
        resolveLedger,
        channel,
        messageTs,
        text,
        originalBlocks,
        ledgerHint,
      });
    },

    pendingCount() {
      return pendingApprovals.size;
    },
  };

  return controller;
}
