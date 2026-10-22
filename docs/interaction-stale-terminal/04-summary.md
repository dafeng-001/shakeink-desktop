# 实施总结：交互失效终态化与已填答案回填

日期：2026-10-21 · 状态：已实施（范围验证通过）

## 问题

回答「参谋想请你确认」后，服务端判定提案调整已失效（`INTERACTION_STALE`「原提案或调整范围已变化，请重新核对」），界面却：

1. 把 4xx 拒绝渲染成「生成中断」；
2. 恢复原问答面板，可再次提交同一死问题；
3. 「查看最新选项」重载后旧面板复活；
4. 直接发新消息被 `QUESTION_PENDING` 拦住；
5. 只有 Esc 能退出。

## 根因

- 前端 `send` 在 `!accepted` 时无条件恢复提交前的 `pendingQuestion`（旧 `use-agent-chat.ts:690`）；
- 服务端抛 `INTERACTION_STALE` 后 interaction 仍为 `pending`、turn 仍为 `waiting_user`，没有终态；
- `restoredQuestion` 只检查 `pending`，重载必然复活；
- `INTERACTION_STALE` 未映射标题，错误卡回退「生成中断」。

## 实施

| 层 | 改动 |
|---|---|
| 协议 | `src/lib/chat-protocol.ts` 新增 `STALE_INTERACTION_CODES`（`INTERACTION_STALE / INTERACTION_CONSUMED / NAVIGATION_REFRESHED`）。`VERSION_CONFLICT` 不纳入，避免误伤审批/计划/内容冲突。 |
| 客户端 | `use-agent-chat.ts` 以实际发送体 `body.interaction` 判定；失效码不恢复 `pendingQuestion/pendingPlan`；网络/5xx/非失效 4xx 仍恢复。 |
| 服务端 | `chat-turn.ts` 新增 `StaleInteractionError`，在 planningAdjustment 内容校验失败处抛出；事务回滚后 `closeStaleInteraction` 调 `skipChatInteraction` 置 `skipped/succeeded`。导航刷新失败分支同样置终态，并统一抛 `INTERACTION_STALE`。 |
| UI | `ChatPanel.tsx` 仅对 `!message.turnId` 的本地被拒发送显示「提问已失效/已处理/选项已更新」，隐藏「作为新消息重发」；「查看最新选项」保留（含 `VERSION_CONFLICT`）。 |
| 回填 | 复用 `sendText` 既有 `!accepted && !draft → setDraft(text)`：面板关闭后，本次提交的完整答案文本回到输入框；不覆盖用户新输入。 |

## 测试证据

- TDD 红（修复前）：
  - `STALE-A01`：turn 仍 `waiting_user`（预期 `succeeded`）；
  - `U-STALE-01`：`pendingQuestion` 被恢复；
  - `CES-12`：失效后面板未关闭。
- TDD 绿（修复后）：
  - `tests/integration/interaction-stale-terminal.test.ts` 2/2；
  - `tests/integration/story-navigation-refresh.test.ts` 7/7（含 STALE-07）；
  - `tests/unit/chat-hook-review.test.ts` 9/9；
  - `tests/browser/chat-empty-state.test.ts` 31/31（含 CES-12，系统 Chrome via `SHAKEINK_TEST_CHROMIUM`）；
  - `npm run typecheck` 通过（先执行 `npm run generate:test`）。
- 全量 `npm test`：2251 tests，2194 pass / 40 fail / 0 skipped（在 P1 收紧前执行）。P1 收紧仅影响失效码白名单与导航失败分支，受影响用例已复跑：unit 9/9、interaction-stale-terminal 2/2、story-navigation-refresh 7/7、browser 31/31。失败均为基线既有平台/环境问题（macOS 签名、Windows 路径分隔符、重型桌面/OPT 用例超时）；已用 `git stash` 暂存本次源码改动，单独复跑 3 条代表性失败用例，确认同样失败，与本次改动无关。
- 浏览器用例已单独跑完全文件 31/31；`SHAKEINK_TEST_CHROMIUM` 指向本机 Chrome（Playwright 默认 Chromium 未安装）。

## 用户可见结果

- 失效提问：面板关闭，错误卡显示「提问已失效」，不再出现「生成中断」和「作为新消息重发」；
- 已填答案回到输入框，可直接修改后作为新消息发送；
- 「查看最新选项」重载不再复活旧面板；
- 服务端已把失效交互置终态，下一条消息不再被 `QUESTION_PENDING` 拦住；
- 网络/5xx 失败仍保留原面板供重试。

## 已知边界（未纳入本次）

- 回填只恢复文本，不恢复 `storySelection`（选项已失效，自由回答可接受）；
- `questionAnswer` 格式不匹配与内容失效仍合并为同一终态；UI 只产生标准 `【回答问题】` 文本，未新增回答格式错误码；
- 队列「立即发送」仍可能覆盖刚回填的草稿（既有行为）；
- 未做真实 Electron 安装包验证；CES-12 仅覆盖本地 fixture，不覆盖真实 `conversationId` 下的「查看最新选项」按钮。
