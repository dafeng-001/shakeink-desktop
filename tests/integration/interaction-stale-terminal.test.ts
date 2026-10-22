import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { PrismaClient } from "../../src/generated/prisma/client"
import { LocalPGliteAdapter } from "../../desktop/service/database/pglite-adapter"
import { runInDatabaseContext } from "../../desktop/service/context"
import { loadMigrations, migrateDatabase } from "../../desktop/service/database/migrations"
import { prisma } from "../../src/lib/db"
import { beginChatRequest } from "../../src/lib/services/chat-turn"
import { storyJson } from "../../src/lib/services/story-artifacts"
import { ContentError } from "../../src/lib/content-errors"

// 用例：docs/interaction-stale-terminal/03-test-cases.md（STALE-A01/A02）。
// 仅允许单文件运行：node --import tsx --test tests/integration/interaction-stale-terminal.test.ts

let root: string
let engine: PGlite
let client: PrismaClient

before(async () => {
  root = await mkdtemp(join(tmpdir(), "interaction-stale-terminal-"))
  engine = await PGlite.create({ dataDir: join(root, "pg") })
  await migrateDatabase(engine, await loadMigrations(join(process.cwd(), "prisma/migrations")))
  client = new PrismaClient({ adapter: new LocalPGliteAdapter(engine) })
})
after(async () => {
  await client?.$disconnect()
  await engine?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

function run<T>(fn: () => T): T {
  return runInDatabaseContext({ workspaceId: "interaction-stale-terminal", database: client }, fn)
}

/** 待答提案调整题：origin 指向不存在的 turn，validateStoredPlanningAdjustment 稳定返回 null */
async function seedPendingQuestion(revision = 1) {
  return run(async () => {
    const suffix = randomUUID()
    const user = await prisma.user.create({ data: { email: `stale-${suffix}@fixture.invalid`, passwordHash: "fixture-hash", name: "夹具作者" } })
    const novel = await prisma.novel.create({ data: { userId: user.id, title: "交互失效夹具作品" } })
    const conversation = await prisma.conversation.create({ data: { userId: user.id, novelId: novel.id, title: "交互失效会话" } })
    const question = "这份规划提案暂不采用。本次只调整原提案涉及的候选内容，请选择需要核对的方面："
    const payload = {
      markerStyle: "letters",
      questions: [{ question, options: ["节拍与讲述顺序", "资料与事件关联"] }],
      planningAdjustment: {
        proposalId: "missing-proposal", originTurnId: "missing-turn", originInteractionId: "missing-interaction",
        expectedVersion: 1, focusKeys: ["planning:missing-proposal"], phase: "clarify",
      },
    }
    const interactionId = randomUUID()
    const turn = await prisma.chatTurn.create({ data: {
      userId: user.id, conversationId: conversation.id, userMessageId: randomUUID(), clientRequestId: `seed-${suffix}`,
      status: "waiting_user",
      interaction: storyJson({ id: interactionId, kind: "question", revision, state: "pending", payload }),
    } })
    return { user, novel, conversation, turn, interactionId, question }
  })
}

test("STALE-A01 失效提案回答被拒后置终态并解除 QUESTION_PENDING", async () => {
  const seed = await seedPendingQuestion()
  await run(async () => {
    await assert.rejects(
      beginChatRequest(seed.user.id, {
        clientRequestId: `answer-${randomUUID()}`,
        conversationId: seed.conversation.id,
        interaction: { turnId: seed.turn.id, id: seed.interactionId, revision: 1, action: "answer" },
        message: `【回答问题】${seed.question}\n我的回答：节拍与讲述顺序`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError)
        assert.equal(error.code, "INTERACTION_STALE")
        assert.match(error.message, /原提案或调整范围已变化/)
        return true
      },
    )
    const closed = await prisma.chatTurn.findUniqueOrThrow({ where: { id: seed.turn.id } })
    assert.equal(closed.status, "succeeded")
    assert.equal((closed.interaction as { state?: string } | null)?.state, "skipped")
    // 终态后普通消息不再被 QUESTION_PENDING 拦住
    const next = await beginChatRequest(seed.user.id, {
      clientRequestId: `next-${randomUUID()}`, conversationId: seed.conversation.id, message: "继续",
    })
    assert.equal(next.turn.status, "queued")
  })
})

test("STALE-A02 revision 不匹配不终止较新提问", async () => {
  const seed = await seedPendingQuestion(2)
  await run(async () => {
    await assert.rejects(
      beginChatRequest(seed.user.id, {
        clientRequestId: `answer-${randomUUID()}`,
        conversationId: seed.conversation.id,
        interaction: { turnId: seed.turn.id, id: seed.interactionId, revision: 1, action: "answer" },
        message: `【回答问题】${seed.question}\n我的回答：节拍与讲述顺序`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError)
        assert.equal(error.code, "INTERACTION_STALE")
        assert.match(error.message, /问题或计划已变化/)
        return true
      },
    )
    const stillOpen = await prisma.chatTurn.findUniqueOrThrow({ where: { id: seed.turn.id } })
    assert.equal(stillOpen.status, "waiting_user")
    const interaction = stillOpen.interaction as { state?: string; revision?: number } | null
    assert.equal(interaction?.state, "pending")
    assert.equal(interaction?.revision, 2)
  })
})
