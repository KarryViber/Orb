const CRON_PROTOCOL_TEXT = `【Cron 执行协议（scheduler 自动注入，所有 cron worker 适用）】

0. 优先级铁律：本协议是本轮 cron turn 的最高约束，**压过**任何 session resume 时
   CLI 注入的 "Continue from where you left off" / 上一轮残留意图 / 历史 thread
   续作启发式。重入（--resume）场景下，若历史 session 暗示「继续投递 / 继续
   chat.postMessage / 继续写文件」与本协议（silent / no-post / deliver.mode）
   冲突时，**一律以本协议为准**，丢弃续作启发式。续作仅适用于「同一任务的
   计算/分析续接」，不得跨越本协议的投递与副作用边界。

1. 投递分发由 scheduler 按 deliver.mode 统一处理，禁止：
   - 调用任何投递脚本（cron-deliver.sh 已废弃）
   - 自行 chat.postMessage / Slack Block Kit POST
   - 写入 evolution_state.py 之外的 cron-results 文件

2. 输出契约：
   - 有可交付内容时写 /tmp/cron-output-<cron_id>.json，结构：
     {"status":"ok|fail|skip","main":"...","thread_md":"...","blocks":[...]}
   - blocks 形态接受两种（runtime 自适应）：
     A. Slack 原生 Block Kit，每项必含 \`type\` 字段：
        [{"type":"section","text":{"type":"mrkdwn","text":"..."}}, ...]
     B. Legacy attachment-shape（不带 color 时 runtime 转原生 blocks；显式 color 才转 Slack attachments 保留色条）：
        [{"color":"#5865F2","header":"标题","body":"markdown 正文"}, ...]
   - 两种形态可混用；任一项既缺 \`type\` 也缺 header/body/color → invalid，cron 立刻失败上报
   - 无内容 → 最终输出单行 [SILENT]
   - 失败 → 最终输出单行 failed: <reason>

3. thread_md 是 degraded fallback；blocks 可同时存在。evolution_state
   模式会把二者都写入 cron-results，聚合投递优先使用 blocks。

4. evolution_state 模式 cron 必须传 --cron-id 且映射在
   <profile-data-dir>/evolution/categories.yaml（当前 profile 的 dataDir）。

详细契约：specs/cron-delivery-contract-2026-05-03.md`;

export const cronProtocolProvider = {
  name: 'cron-protocol',
  async prefetch(ctx = {}) {
    const { origin } = ctx;
    if (origin?.kind !== 'cron') return [];
    const dataDir = ctx?.profile?.dataDir || ctx?.dataDir || '<profile-data-dir>';
    return [{
      label: 'cron-protocol',
      source_type: 'system_protocol',
      trusted: true,
      origin: 'scheduler:cron-dispatch',
      content: CRON_PROTOCOL_TEXT.replaceAll('<profile-data-dir>', dataDir),
    }];
  },
};

export default cronProtocolProvider;
