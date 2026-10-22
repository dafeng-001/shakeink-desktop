# 测试用例：交互失效终态化与答案回填（方案 A）

日期：2026-10-21 · 对应方案：`02-technical-plan.md`

## 1. 范围

覆盖：提交答案被服务端判定失效后的客户端面板/回填/错误卡、服务端 interaction 终态、后续消息解除阻塞、revision 不匹配不误终止。
不覆盖：方案 C 的提案题重建、普通生成中断、队列「立即发送」覆盖草稿的既有边界。

## 2. 用例

### STALE-A01 失效提案回答被拒后置终态并解除 QUESTION_PENDING（集成）

**种子**：PGlite + 真实迁移；user、novel、conversation（novelId 非空）、waiting_user turn；interaction payload：

```json
{
  "markerStyle": "letters",
  "questions": [{ "question": "这份规划提案暂不采用。本次只调整原提案涉及的候选内容，请选择需要核对的方面：", "options": ["节拍与讲述顺序", "资料与事件关联"] }],
  "planningAdjustment": {
    "proposalId": "missing-proposal",
    "originTurnId": "missing-turn",
    "originInteractionId": "missing-interaction",
    "expectedVersion": 1,
    "focusKeys": ["planning:missing-proposal"],
    "phase": "clarify"
  }
}
```

**动作**：`beginChatRequest(userId, { clientRequestId, conversationId, interaction: { turnId, id, revision: 1, action: "answer" }, message: "【回答问题】…\n我的回答：节拍与讲述顺序" })`。

**预期**：
1. 拒绝，`ContentError.code === "INTERACTION_STALE"`，message 含「原提案或调整范围已变化」；
2. 重新读取 turn：`interaction.state === "skipped"`，`turn.status === "succeeded"`；
3. 再发普通消息 `{ clientRequestId: new, conversationId, message: "继续" }` 成功建立新回合（`turn.status === "queued"`），不抛 `QUESTION_PENDING`。

**反证**：修复前第 2 项为 `pending`、`waiting_user`，第 3 项抛 `QUESTION_PENDING`。

### STALE-A02 revision 不匹配不终止较新提问（集成）

**种子**：同 STALE-A01，但 interaction revision = 2、state pending。

**动作**：显式携带种子 `conversationId`，提交 `interaction.revision = 1` 的答案。

**预期**：
1. 拒绝，code `INTERACTION_STALE`，message 含「问题或计划已变化」；
2. turn 仍为 `waiting_user`，interaction.state 仍为 `pending`、revision 仍为 2（不得被过期提交终止）。

### STALE-A03 导航刷新失败时也置终态（集成，复用 story-navigation 种子）

**种子**：复用 `tests/integration/story-navigation-refresh.test.ts` 的 `seedCommon()`；清空 itemA 的 description（同 STALE-06），使刷新塌缩为唯一下一步。

**动作**：`beginChatRequest` 回答该 storyNavigation 面板（`interaction.action="answer"` + 合法答案/选项）。

**预期**：
1. 拒绝，code 为 `INTERACTION_STALE`；
2. turn 变为 `succeeded`、interaction 变为 `skipped`（导航刷新失败分支同样不得留下 pending 死面板）。

### U-STALE-01 失效码不恢复问答面板（单元，hook harness）

**种子**：`controlledHook` 的 store 设 `pendingQuestion`（带完整 interaction：turnId/id/revision/action）；mock `/api/chat` 返回 `409 { code: "INTERACTION_STALE", error: "原提案或调整范围已变化，请重新核对" }`。

**动作**：`await hook.send("【回答问题】…", "novel-a")`。

**预期**：返回 false；`state.pendingQuestion === null`；`state.isGenerating === false`。
参数化遍历 `INTERACTION_CONSUMED / NAVIGATION_REFRESHED`，均不得恢复。

**前置修正**：harness 的 `@/lib/chat-protocol` mock 必须补 `STALE_INTERACTION_CODES`（import 真值转出），否则 `undefined.has` 抛错。

### U-STALE-02 网络失败仍恢复面板（单元，hook harness）

**种子**：同上（携带 interaction）；mock fetch 直接 throw 网络错误。

**动作**：`await hook.send(...)`。

**预期**：`state.pendingQuestion` 仍为原对象（可重试语义不变）。

### U-STALE-03 4xx 非失效码仍恢复面板（单元，hook harness）

**种子**：同上；mock `/api/chat` 返回 `409 { code: "INTERACTION_ACTION_INVALID", error: "交互动作不匹配" }`。

**预期**：`state.pendingQuestion` 恢复、`state.isGenerating === false`（白名单不得误伤其他 4xx）。

### U-STALE-04 VERSION_CONFLICT 仍恢复面板（单元，hook harness）

**种子**：同上；mock `/api/chat` 返回 `409 { code: "VERSION_CONFLICT", error: "审批或计划内容已变化" }`。

**预期**：`state.pendingQuestion` 恢复（审批/计划冲突不等同交互失效），「查看最新选项」路径保留。

### CES-12 面板关闭、答案回填、错误卡改称「提问已失效」（浏览器）

**夹具**：`mountChatEmpty` 新增 `chatReject(code, message)`；`/api/chat` POST 命中时返回 409 JSON。

**动作**：
1. 选择合成模型；
2. `pendingQuestion`：单问题「合成待答问题」、选项「合成选择」、interaction `{ turnId: "ces12-turn", id: "ces12-ia", revision: 1, action: "answer" }`；
3. 设置 `chatReject("INTERACTION_STALE", "原提案或调整范围已变化，请重新核对")`；
4. 点击 `ask-option-0-0`。

**预期**：
1. `state.pendingQuestion === null`，`state.isGenerating === false`；
2. `state.draft` 为 `【回答问题】合成待答问题\n我的回答：合成选择`（回填）；
3. composer 实际渲染文本与 `state.draft` 一致；
4. `ask-user-panel` 数量 0；
5. 错误卡出现「提问已失效」，不出现「生成中断」；
6. 不出现「作为新消息重发」按钮。

**说明**：CES-12 只验证文本回填；`storySelection` 不恢复（选项已失效，自由回答可接受）。

## 3. 运行命令

```powershell
node --import tsx --test tests/integration/interaction-stale-terminal.test.ts
node --import tsx --test tests/integration/story-navigation-refresh.test.ts
node --import tsx --test tests/unit/chat-hook-review.test.ts
node --import tsx --test --test-concurrency=1 --test-reporter=tap tests/browser/chat-empty-state.test.ts
npm run typecheck
npm test
```

浏览器用例需要本机 Playwright Chromium（`playwright-core`，可用 `SHAKEINK_TEST_CHROMIUM` 指定）。CES-12 不覆盖「查看最新选项」（需 conversationId），该按钮由 STALE-A01 的服务端终态与既有重载路径保证。

## 4. 验收口径

- STALE-A01/A02/A03、U-STALE-01/02/03/04、CES-12 全绿；
- 修复前 STALE-A01 的 2/3 项、CES-12 的面板/标题项必须复现失败（TDD 红）；
- `npm run typecheck` 无错误；
- `npm test` 全量通过；浏览器用例单独通过；
- 结果与失败项原样记录到实施总结，不把未执行标为通过。
