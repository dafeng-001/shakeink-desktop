# 技术方案：交互失效终态化与已填答案回填（方案 A）

日期：2026-10-21 · 状态：待独立审核

## 1. 问题与目标

现象（用户截图）：回答「参谋想请你确认」后，服务端判定提案调整已失效，返回 `INTERACTION_STALE`「原提案或调整范围已变化，请重新核对」；界面同时出现红色「生成中断」错误卡和**原问答面板**，再次提交仍是同一错误；「查看最新选项」重载后旧面板再次出现，直接发新消息被 `QUESTION_PENDING` 拦住，只有 Esc 能退出。

目标：

1. 交互失效不再显示为「生成中断」，不再恢复旧问答面板；
2. 失效的 interaction 在服务端进入终态，后续消息不被 `QUESTION_PENDING` 阻塞，重载不复活旧面板；
3. 关闭面板时把用户已填内容回填到输入框，避免重填；
4. 不改变网络/5xx/未知失败的可重试语义。

非目标：不重建 planningAdjustment 澄清题（方案 C）、不新增 interaction 状态值、不调整普通生成中断的既有呈现。

## 2. 现状链路（代码证据）

1. 提交答案前 `send` 把 `pendingQuestion` 置空（`use-agent-chat.ts:498`），请求携带旧 `interaction`（`:487`）。
2. 服务端 `validateStoredPlanningAdjustment` 失败，抛 `INTERACTION_STALE`（`chat-turn.ts:266-269`），事务回滚；interaction 仍为 `pending`、turn 仍为 `waiting_user`。
3. 前端 4xx 统一走 `finish("interrupted", …)`，并因 `!accepted` 恢复提交前的 `pendingQuestion`（`use-agent-chat.ts:688-693`、`:511-518`）。
4. 错误卡标题回退为「生成中断」（`ChatPanel.tsx:775`）；`INTERACTION_STALE` 未映射标题/动作。
5. 面板因 `pendingQuestion != null && !isGenerating` 重新出现（`ChatPanel.tsx:934`、`:2007-2012`）。
6. 「查看最新选项」重载后 `restoredQuestion` 只检查 `pending`，再次恢复旧面板（`use-agent-chat.ts:108-114`）。
7. 直接发新消息撞 `QUESTION_PENDING`（`chat-turn.ts:232-234`）。
8. 同类问题已有 storyNavigation 自愈先例：`docs/story-navigation-refresh-healing/07-summary.md`。

## 3. 设计决策

### 3.1 共享失效码集合

在 `src/lib/chat-protocol.ts` 新增：

```ts
/** 服务端判定当前交互不可再消费的 wire code：前端不得恢复旧面板，也不得重放同一 interaction。 */
export const STALE_INTERACTION_CODES: ReadonlySet<string> = new Set([
  "INTERACTION_STALE",
  "INTERACTION_CONSUMED",
  "NAVIGATION_REFRESHED",
])
```

**审核修正（P1）**：`VERSION_CONFLICT` 不进入该集合。同一请求内的审批（`approveStoryVersion`）、计划批准（`createPlanInTransaction`）、内容采用（`acceptStoryContentApproval`）也可能抛 `VERSION_CONFLICT`，此时交互仍 pending；若把它当失效码会误关面板、误改标题。`VERSION_CONFLICT` 仅保留在「查看最新选项」按钮条件与原错误卡回退逻辑中。

只对**实际发送体中携带 interaction 的请求**生效，避免影响普通内容冲突或普通消息。

### 3.2 客户端：按错误码决定是否恢复

`use-agent-chat.ts` 的 `send` catch：

```ts
// 注意：pendingRequest 重放时 requested.interaction 可能为空，必须读实际发送体 body
const sentInteraction = (JSON.parse(body) as { interaction?: unknown }).interaction
const staleInteraction = !!sentInteraction && STALE_INTERACTION_CODES.has(submitErrorCode ?? "")
if (!accepted && !staleInteraction) {
  pendingQuestion = store.pendingQuestion
  pendingPlan = store.pendingPlan
}
```

审核修正：`requested.interaction` 不等于实际发送体——`pendingRequest` 重放路径使用旧 `body`，若只看 `requested` 会把重放失效请求误判为可恢复。改为读取 `body` 中的 interaction。

- `INTERACTION_STALE / INTERACTION_CONSUMED / NAVIGATION_REFRESHED`：不恢复旧面板，旧 interaction 不进入下一次发送。
- `VERSION_CONFLICT`：仍恢复原面板/卡片（审批或计划冲突不代表交互失效），保留「查看最新选项」。
- 网络/5xx/未知失败：沿用原逻辑恢复面板，用户可重试。
- 不改 `finish` 的状态机；本次只收紧恢复条件。

### 3.3 服务端：失效即终态

`chat-turn.ts`：

1. 新增内部标记（不直接外泄）：

```ts
class StaleInteractionError extends Error {
  constructor(readonly reason: ChatProtocolError, readonly turnId: string, readonly interactionId: string, readonly revision: number) { super(reason.message) }
}
```

2. 仅在「存储 interaction 已通过 id/revision/pending 校验，但内容校验失败」处抛出（当前为 `:268` 的 planningAdjustment 分支）。`revision` 不匹配（`:224`）**不**包装，避免误终止服务端较新的有效提问。
3. `StaleInteractionError` 必须携带**来源交互所属的 turn**（`:268` 处新 turn 尚未创建，不能传新 turn id；用 `input.interaction.turnId` / `interactionTurn.id`），否则 `skipChatInteraction` 会 `TURN_NOT_FOUND` 且被吞掉，缺陷仍在。
4. 事务回滚后的 `.catch`：

```ts
if (error instanceof StaleInteractionError) {
  try { await skipChatInteraction(userId, error.turnId, error.interactionId, error.revision) }
  catch { /* 并发已回答/已跳过：保留原错误，不覆盖真实状态 */ }
  throw error.reason
}
```

复用现有 `skipChatInteraction`（`chat-turn.ts:439-451`）把 interaction 置 `skipped`、turn 置 `succeeded`，不新增状态值、不做迁移。相对现有 `NavigationContentStaleError` 自愈路径新增一个同级 catch 分支。

4. 导航刷新失败兜底：`NavigationContentStaleError` catch 中，`refreshStoryNavigation` 失败且原因为 `INTERACTION_STALE`/`VERSION_CONFLICT` 时，同样调用 `closeStaleInteraction` 后**统一抛 `INTERACTION_STALE`**（原始 `VERSION_CONFLICT` 可能是审批/计划冲突，不能外推为失效码）；刷新成功仍走 `NAVIGATION_REFRESHED`（面板 revision+1，保持 pending，可重新回答）。该分支的 revision 校验在面板已刷新时可能失败并被吞掉（记录 `console.warn`），属已知降级，不覆盖真实状态。

不改 `:210` 的重试提案调整校验（不涉及当前待答面板）；不改 `skipChatInteraction` 的用户 Esc 语义。

### 3.4 回填已填内容

`ChatPanel.sendText` 已有统一兜底：发送未被收下且当前草稿为空时 `setDraft(text)`（`ChatPanel.tsx:1288-1289`）。失效面板关闭后该兜底自然显现：

- 回填的是本次提交的完整答案文本（含 `【回答问题】…` 结构），保留问题上下文且可直接编辑；
- 仅当草稿为空时回填，不覆盖用户在请求期间新输入的内容；
- 不新增解析逻辑，避免多问题答案丢失或错配。

### 3.5 错误卡文案与按钮

`ChatPanel.tsx` 新增按 wire code 的标题映射：

```ts
const STALE_INTERACTION_TITLES: Record<string, string> = {
  INTERACTION_STALE: "提问已失效",
  INTERACTION_CONSUMED: "提问已处理",
  NAVIGATION_REFRESHED: "选项已更新",
}
```

- 标题优先使用该映射，不再回退「生成中断」；**仅限 `!message.turnId` 的本地被拒发送**——带 turnId 的服务端终态（如 `:210` 重试恢复路径）仍走原「生成中断/重试本轮」语义，避免误伤；
- 这些码（同样仅 `!message.turnId`）隐藏「作为新消息重发」（避免重放已失效 interaction 或制造重复气泡）；
- 保留「查看最新选项」：条件为 `STALE_INTERACTION_CODES.has(code) || code === "VERSION_CONFLICT"`，保留审批/计划冲突的既有重载入口；
- 复制错误详情保留。

## 4. 行为矩阵

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| 回答失效提案（409 INTERACTION_STALE） | 生成中断 + 面板复活 + 重载复活 + 新消息被阻塞 | 「提问已失效」+ 面板关闭 + 服务端置 skipped + 新消息可发 + 答案回填 |
| 重复提交已被消费的答案（INTERACTION_CONSUMED） | 生成中断 + 面板复活 | 「提问已处理」+ 面板关闭 |
| 导航选项已刷新（NAVIGATION_REFRESHED） | 生成中断 + 旧面板复活 | 「选项已更新」+ 面板关闭；重载显示刷新后的新面板 |
| 网络/5xx/未知失败 | 恢复面板可重试 | 不变 |
| 旧 revision 提交（服务端有更新提问） | 409 INTERACTION_STALE | 报错但不终止服务端较新的 pending 提问 |

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 并发回答成功后又被终止 | `skipChatInteraction` 对非 pending 抛错并被吞掉；原错误返回，重载显示真实状态 |
| 误终止较新的有效提问 | 只包装内容校验失败的抛点；revision 不匹配路径不包装，并加回归用例 |
| 回填覆盖用户新输入 | 沿用既有 `!draft` 判空（代码保证）；本次不新增延迟失败用例 |
| 失效码被普通内容冲突误用 | 仅当实际发送体 `body.interaction` 存在时停止恢复 |
| 误伤带 turnId 的重试恢复错误卡 | 标题/按钮映射仅在 `!message.turnId` 时生效 |
| 队列「立即发送」覆盖回填草稿 | 已识别为既有边界，非本次阻断；必要时后续以 `!draft` 判空收紧 |
| `skipChatInteraction` 额外事务开销 | 仅失败路径触发，罕见；复用现有逻辑，无迁移 |

## 6. 测试计划

1. `tests/integration/interaction-stale-terminal.test.ts`
   - 种子：user + novel + conversation(novelId) + waiting_user turn，interaction payload 带一个 `planningAdjustment`（`originTurnId` 指向不存在的 turn，`focusKeys` 至少 1 项）；答案是合法 `【回答问题】…` 文本，因此稳定走 `!verified` 分支触发 `:268`，无需真实 `proposeNovelPlanning` 收据。
   - STALE-A01：失效提案回答被拒 → code INTERACTION_STALE；turn.interaction.state=`skipped`、turn.status=`succeeded`；随后普通消息可建立新回合（不再 QUESTION_PENDING）。
   - STALE-A02：revision 不匹配（服务端 rev 2，提交 rev 1）→ 报 INTERACTION_STALE；服务端较新 pending 提问保持 `pending`/`waiting_user`。
2. `tests/unit/chat-hook-review.test.ts`
   - 测试替身的 `@/lib/chat-protocol` mock 必须补上真实 `STALE_INTERACTION_CODES`（直接 import 后转出，不能手写副本）。
   - U-STALE-01：409 INTERACTION_STALE 后 `pendingQuestion` 为 null（不恢复）。
   - U-STALE-02：网络失败后 `pendingQuestion` 恢复（可重试语义不变）。
3. `tests/browser/chat-empty-state.test.ts` 新增 CES-12
   - 夹具新增 `chatReject(code,message)`：`/api/chat` POST 返回 409 JSON；
   - 断言面板关闭、`draft` 回填为本次答案文本、错误卡显示「提问已失效」、不出现「生成中断」与「作为新消息重发」；
   - 说明：回填只恢复文本，不恢复 `storySelection`（导航选项已失效，退化为自由回答可接受）。
4. 命令：目标文件单跑 → `npm run typecheck` → `npm test`（unit+integration）→ 浏览器用例单跑。

## 7. 验收证据

- 代码：上述文件的实际 diff；
- 测试：目标用例与全量 `npm test` 结果；浏览器用例结果；
- 台账：`docs/requirements-traceability.json` 增补 `staleInteractionTerminalizationRevision`（实施后）。
