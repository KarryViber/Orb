# Spec: 记忆系统架构重构 — mem0 语义 + Graphiti 墓碑

> **本 spec 替代了原「统一衰减链路」方案。** 调研（thread `1776366020.294949`）表明业界没人再做指数 trust 衰减，主流已收敛到「写时 LLM 仲裁 + 双时态墓碑」。我们的「两套衰减互相打架」设计是淘汰路线，不是先进路线。

## 核心思路

1. **删掉所有时间衰减** — `decay.py` 和 `memory.js::decayFacts` 整体废弃
2. **`trust_score` 改为写入时一次性打分**，不再自然变化（helpful/unhelpful 反馈保留）
3. **新增 `invalid_at` + `superseded_by` 列**（Graphiti 墓碑）— fact 永不硬删，只打标
4. **`add_fact` 内嵌一次 Haiku 调用**，检索近邻后判 ADD / UPDATE / DELETE / NONE（mem0 prompt）
5. **瞬时类别硬删例外**：`transient_state` / `session_context` 保留按时间删除

## 改动清单

### 1. Schema 迁移

**文件：** `lib/holographic/store.py::_init_db`

```python
if "invalid_at" not in columns:
    self._conn.execute("ALTER TABLE facts ADD COLUMN invalid_at TIMESTAMP")
if "superseded_by" not in columns:
    self._conn.execute("ALTER TABLE facts ADD COLUMN superseded_by INTEGER REFERENCES facts(fact_id)")
if "trust_frozen" not in columns:
    self._conn.execute("ALTER TABLE facts ADD COLUMN trust_frozen INTEGER DEFAULT 0")
```

索引：
```sql
CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(invalid_at) WHERE invalid_at IS NULL;
```

`search_facts` 和 `list_facts` 全部加上 `AND invalid_at IS NULL` 默认过滤（提供 `include_invalidated=True` 开关用于审计）。

### 2. 写时仲裁：新增 `_arbitrate_upsert`

**文件：** `lib/holographic/store.py`

在 `add_fact` 入口先做 FTS5 + trust top-3 近邻检索（trust > 0.3，invalid_at IS NULL），若近邻非空：

调用 Haiku（通过 `bridge.py` 新增 `arbitrate` command），prompt 模板（参考 mem0 `DEFAULT_UPDATE_MEMORY_PROMPT`）：

```
You are a memory curator. Given a NEW fact and existing NEIGHBORS,
decide: ADD / UPDATE / DELETE / NONE.

NEW: {content}
NEIGHBORS:
  [id=12] {content} (trust=0.8)
  [id=47] {content} (trust=0.5)

Return JSON: {"action": "UPDATE", "target_id": 12, "reason": "..."}
- ADD: new info, no conflict
- UPDATE: new contradicts/supersedes target_id (tombstone old, add new, link superseded_by)
- DELETE: new says old is wrong (tombstone target, no add)
- NONE: duplicate or strictly-weaker info (no write)
```

`bridge.py` 调用方：Python 侧通过 Orb worker 的 `ANTHROPIC_API_KEY` 环境变量直连 SDK（`anthropic` pypi 包，已在 lib/holographic requirements）。Model 固定 `claude-haiku-4-5-20251001`，max_tokens 200。

失败降级：LLM 报错 / 超时 3s → 默认 ADD（保守），日志 warn。

### 3. 墓碑而不是删除

**文件：** `lib/holographic/store.py`

新增 `_tombstone(fact_id, superseded_by=None)`：
```python
UPDATE facts SET invalid_at = CURRENT_TIMESTAMP, superseded_by = ? WHERE fact_id = ?
```

原 `remove_fact` 改名 `purge_fact`，仅用于 admin/迁移。默认所有流程走 tombstone。

### 4. `trust_score` 冻结

**文件：** `lib/holographic/store.py::add_fact`

新增参数 `confidence: str = "default"`：
- `"confirmed"` → 0.9（用户明确确认）
- `"default"` → 0.5（常规抽取）
- `"speculative"` → 0.2（推测、模糊）

写入后 `trust_frozen = 1`，`record_feedback` 仍可调整（helpful +0.05 / unhelpful -0.1），但无时间衰减。

### 5. 废弃时间衰减

**删除：**
- `lib/holographic/decay.py`（整个文件，git rm）
- `src/memory.js::decayFacts` + `DECAY_POLICIES` 常量
- `src/scheduler.js` 第 542 行对 `decayFacts` 的调用 + import

**保留：**
- `lintMemory`（孤儿/重复清理）
- helpful_count / retrieval_count（不做衰减，但数据保留供观测）

### 6. 瞬时类别例外

**文件：** `lib/holographic/store.py`

新增 `purge_transient(db_path, categories=("transient_state", "session_context"), max_age_days=7)`：对这些 category 直接 DELETE（不是 tombstone，真删）。由 scheduler 每日调用一次即可。

### 7. 抽取层对齐

**文件：** `lib/holographic/extract.py`

确保抽取出的 fact 带上 `confidence` 字段（参考 SOUL 里的置信度约定）。现有 `extract_facts` 若无该字段默认 `"default"`。

## 不做的事（明确排除）

- **不引入向量嵌入做语义去重**：FTS5 trigram 足够找近邻，向量成本不值得
- **不改 HRR bank 机制**：保留原样
- **不做批量回填仲裁**：存量 fact 不追溯，让时间自然过滤
- **不改 MEMORY.md 蒸馏逻辑**：memory-sync 继续按原流程跑

## 成本与影响

- Haiku 调用：每条新 fact ~200 tokens in + 50 out ≈ $0.0005。按每天 50 条新 fact 算 $0.025/天
- 延迟：+200-500ms per `add_fact`。接受（fact 抽取本身就不在关键路径）
- Fallback：API 不通时默认 ADD，绝不阻塞

## 执行顺序

1. `store.py` schema 迁移（加 3 列 + 索引）
2. `search_facts` / `list_facts` 加 `invalid_at IS NULL` 过滤
3. `bridge.py` 加 `arbitrate` command + Haiku 调用
4. `add_fact` 接入仲裁分支 + 降级逻辑
5. 添加 `_tombstone` + `purge_fact`（重命名）+ `purge_transient`
6. 删除 `decay.py` / `memory.js::decayFacts` / scheduler 调用
7. `extract.py` 带上 confidence 字段
8. 单元测：写入冲突 fact → target 被 tombstone + 新 fact 带 superseded_by=None（因为是新条）
9. `launchctl kickstart` 重启 daemon
10. 观察 24h：orb.log 无 bridge 错误，memory.db 有新 tombstone 产生

## 验证

- [ ] `PRAGMA table_info(facts)` 看到 `invalid_at` / `superseded_by` / `trust_frozen`
- [ ] 手动注入两条冲突 fact，第二条写入后第一条 `invalid_at` 有值
- [ ] `sqlite3 memory.db "SELECT COUNT(*) FROM facts WHERE invalid_at IS NOT NULL"` 有记录
- [ ] `grep decay ~/Orb/src/` 无匹配（除注释）
- [ ] bridge 模拟断网：fact 仍能写入，log 有 warn
- [ ] 搜索结果默认不含 invalidated fact

## 回滚

所有 schema 改动为 additive（不破坏现有列），回滚 = `git revert` 源码 + 保留新列（不影响读写）。极端情况 `UPDATE facts SET invalid_at = NULL` 即可复活全部 fact。
