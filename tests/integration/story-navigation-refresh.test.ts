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
import { navigationContextHash, prepareStoryTask, refreshStoryNavigation } from "../../src/lib/services/story-task"
import { beginChatRequest } from "../../src/lib/services/chat-turn"
import { checkStoryMaterialStructure, updateStoryWorkflow } from "../../src/lib/services/story-workflow"
import { readStoryArtifacts, storyJson, type StoryScope } from "../../src/lib/services/story-artifacts"
import { createItem, updateItem } from "../../src/lib/services/item"
import { ContentError } from "../../src/lib/content-errors"

// 用例与种子：docs/story-navigation-refresh-healing/03-test-cases.md（2026-10-16 审核版）。
// 仅允许单文件运行：node --import tsx --test tests/integration/story-navigation-refresh.test.ts

let root: string
let engine: PGlite
let client: PrismaClient

before(async () => {
  root = await mkdtemp(join(tmpdir(), "story-nav-refresh-"))
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
  return runInDatabaseContext({ workspaceId: "story-nav-refresh", database: client }, fn)
}

/** 公共种子（STALE-01/02/03/05/06 共用）：文档 §2 第 1-8 步。 */
async function seedCommon() {
  return run(async () => {
    const suffix = randomUUID()
    const user = await prisma.user.create({ data: { email: `author-${suffix}@fixture.invalid`, passwordHash: "fixture-hash", name: "夹具作者" } })
    const novel = await prisma.novel.create({ data: { userId: user.id, title: "导航刷新夹具作品" } })
    const scope: StoryScope = { userId: user.id, novelId: novel.id }
    await updateStoryWorkflow(scope, { expectedVersion: 0, brief: "夹具创作简报：主角带着旧罗盘寻找青钢剑的来历与阻力。" })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, index: 1, title: "第一卷", summary: "卷一概要" } })
    // 章纲非空、正文为空：sceneChoiceId 形态 scene:chapter-outline:<章id>: 的前提。
    const chapter = await prisma.chapter.create({ data: { volumeId: volume.id, index: 1, title: "第一章", outline: "夹具章纲：开场即冲突。", content: "" } })
    // 主叙事线一张未分章实际讲述卡：ready=false 时菜单塌缩为唯一「整理卷章大纲」。
    await prisma.planningDocument.create({ data: { novelId: novel.id, data: {
      worlds: [{ id: "worldline-1", name: "夹具世界线" }],
      lines: [{ id: "line-1", name: "夹具主线", primary: true }],
      cards: [{ id: "card-1", line: "line-1", title: "开场卡", tellings: [{ id: "telling-1" }], chapter: null }],
    } } })
    // description 非空：否则结构检查点 passed=false，面板一开始就没有 question。
    const itemA = await createItem(novel.id, { name: "青钢剑", description: "一柄有来历的剑，剑身刻有古纹。", attributes: [] })
    const itemB = await createItem(novel.id, { name: "旧罗盘", description: "指针始终指向秘境方向的罗盘。", attributes: [] })
    await checkStoryMaterialStructure(scope, `item:${itemA.id}`)
    await checkStoryMaterialStructure(scope, `item:${itemB.id}`)
    const keys = [`item:${itemA.id}`, `item:${itemB.id}`]
    const prepared = await prepareStoryTask(scope, keys, false)
    assert.ok(prepared.question, "种子面板必须存在问答")
    const question = prepared.question
    const sceneChoiceId = `scene:chapter-outline:${chapter.id}:`
    assert.ok(question.storyNavigation.choices.some(choice => choice.id === sceneChoiceId), "种子面板必须含场景选项")
    const conversation = await prisma.conversation.create({ data: { userId: user.id, novelId: novel.id, title: "面板会话", activeAttemptId: null } })
    const interactionId = randomUUID()
    const turn = await prisma.chatTurn.create({ data: {
      userId: user.id, conversationId: conversation.id, userMessageId: randomUUID(), clientRequestId: `seed-${suffix}`,
      status: "waiting_user",
      interaction: storyJson({ id: interactionId, kind: "question", revision: 1, state: "pending", payload: question }),
    } })
    return { scope, user, novel, chapter, itemA, itemB, keys, question, sceneChoiceId, conversation, turn, interactionId }
  })
}

test("STALE-01 回归：编辑物品后刷新面板恢复", async () => {
  const seed = await seedCommon()
  await run(async () => {
    await updateItem(seed.itemA.id, { name: seed.itemA.name, description: "另一段非空描述：剑身古纹其实是一幅地图。", attributes: [] })
    // 反向控制（文档 §2 末段）：编辑后直接 prepare 必须塌缩，否则种子无效。
    const collapsed = await prepareStoryTask(seed.scope, seed.keys, false)
    assert.equal(collapsed.question, undefined)
    assert.equal(collapsed.autoProceed?.task, "outline")
    const next = await refreshStoryNavigation(seed.scope.userId, seed.turn.id, seed.interactionId, 1)
    assert.equal(next.revision, 2)
    assert.equal(next.state, "pending")
    const navigation = next.payload.storyNavigation
    assert.ok(navigation.choices.some(choice => choice.id === seed.sceneChoiceId))
    assert.equal(navigation.contextHash, navigationContextHash(await readStoryArtifacts(seed.scope)))
  })
})

test("STALE-02 端到端：storySelection 点击过期面板不再报错", async () => {
  const seed = await seedCommon()
  await run(async () => {
    await updateItem(seed.itemA.id, { name: seed.itemA.name, description: "改后描述：罗盘指向剑的封印之地。", attributes: [] })
    const binding = await beginChatRequest(seed.scope.userId, {
      clientRequestId: `answer-${randomUUID()}`,
      conversationId: seed.conversation.id,
      interaction: { turnId: seed.turn.id, id: seed.interactionId, revision: 1, action: "answer" },
      storySelection: { kind: "choice", choiceId: seed.sceneChoiceId },
      message: "生成场景",
    })
    assert.equal(binding.turn.status, "queued")
    // 部分匹配：实际 action 还携带 sourceKey（指回面板首目标）。
    const action = binding.turn.action as { kind?: string; task?: string; scope?: { targetKeys?: string[]; sourceKeys?: string[] } } | null
    assert.equal(action?.kind, "storyTask")
    assert.equal(action?.task, "scene")
    assert.deepEqual(action?.scope, { targetKeys: [], sourceKeys: [`chapter-outline:${seed.chapter.id}`] })
    const panel = await prisma.chatTurn.findUniqueOrThrow({ where: { id: seed.turn.id } })
    assert.equal((panel.interaction as { state?: string } | null)?.state, "answered")
  })
})

test("STALE-03 无编辑刷新：幂等零写入", async () => {
  const seed = await seedCommon()
  await run(async () => {
    const itemsBefore = await prisma.item.findMany({ where: { novelId: seed.scope.novelId }, orderBy: { id: "asc" } })
    const workflowBefore = await prisma.storyWorkflow.findUniqueOrThrow({ where: { novelId: seed.scope.novelId } })
    const next = await refreshStoryNavigation(seed.scope.userId, seed.turn.id, seed.interactionId, 1)
    assert.equal(next.revision, 2)
    const itemsAfter = await prisma.item.findMany({ where: { novelId: seed.scope.novelId }, orderBy: { id: "asc" } })
    assert.deepEqual(itemsAfter.map(item => item.updatedAt.getTime()), itemsBefore.map(item => item.updatedAt.getTime()))
    const workflowAfter = await prisma.storyWorkflow.findUniqueOrThrow({ where: { novelId: seed.scope.novelId } })
    assert.equal(workflowAfter.version, workflowBefore.version)
    assert.deepEqual(storyJson(next.payload.storyNavigation.choices), storyJson(seed.question.storyNavigation.choices))
  })
})

test("STALE-04 边界：非快速资料目标不触发 AI 评审", async () => {
  const seed = await seedCommon()
  await run(async () => {
    // growthArc 与 arcStages 均为空：arc 选项才出现，面板才有 question。
    const character = await prisma.character.create({ data: {
      novelId: seed.scope.novelId, name: "林晚", roleType: "SUPPORTING", age: "二十四岁", occupation: "游医",
      personality: "冷静克制", appearance: "清瘦，眼神锐利", clothing: "素色长衫", catchphrase: "先把脉。",
      growthArc: "", arcStages: [], relationships: [], extra: {},
    } })
    const prepared = await prepareStoryTask(seed.scope, [`character:${character.id}`], false)
    assert.ok(prepared.question, "角色面板必须存在问答")
    assert.deepEqual(prepared.question.storyNavigation.choices.map(choice => choice.task), ["arc", "outline"])
    const conversation = await prisma.conversation.create({ data: { userId: seed.user.id, novelId: seed.scope.novelId, title: "角色面板会话", activeAttemptId: null } })
    const interactionId = randomUUID()
    const turn = await prisma.chatTurn.create({ data: {
      userId: seed.user.id, conversationId: conversation.id, userMessageId: randomUUID(), clientRequestId: `seed-${randomUUID()}`,
      status: "waiting_user",
      interaction: storyJson({ id: interactionId, kind: "question", revision: 1, state: "pending", payload: prepared.question }),
    } })
    await prisma.character.update({ where: { id: character.id }, data: { name: "林晚秋" } })
    // 测试环境不配置评审模型：若刷新走 AI 评审必抛模型类错误。
    const next = await refreshStoryNavigation(seed.scope.userId, turn.id, interactionId, 1)
    assert.equal(next.revision, 2)
    const workflow = await prisma.storyWorkflow.findUniqueOrThrow({ where: { novelId: seed.scope.novelId } })
    assert.ok(Object.keys(workflow.checkpoints as Record<string, unknown>).every(key => !key.startsWith("character:")), "刷新只重检快速资料，不得写入 character:* 检查点")
  })
})

test("STALE-05 端到端：标签回答分支（无 storySelection）", async () => {
  const seed = await seedCommon()
  await run(async () => {
    await updateItem(seed.itemA.id, { name: seed.itemA.name, description: "改后描述：剑身古纹指向真正的秘境。", attributes: [] })
    // 真实客户端格式（AskUserPanel.tsx）：标签须与选项 label 精确全等。
    const message = `【回答问题】${seed.question.questions[0].question}\n我的回答：生成场景`
    const binding = await beginChatRequest(seed.scope.userId, {
      clientRequestId: `answer-${randomUUID()}`,
      conversationId: seed.conversation.id,
      interaction: { turnId: seed.turn.id, id: seed.interactionId, revision: 1, action: "answer" },
      message,
    })
    const action = binding.turn.action as { kind?: string; task?: string } | null
    assert.equal(action?.kind, "storyTask")
    assert.equal(action?.task, "scene")
  })
})

test("STALE-06 反向边界：内容清空仍诚实失败", async () => {
  const seed = await seedCommon()
  await run(async () => {
    await updateItem(seed.itemA.id, { name: seed.itemA.name, description: "", appearance: "", acquisition: "", effects: [], attributes: [] })
    await assert.rejects(
      refreshStoryNavigation(seed.scope.userId, seed.turn.id, seed.interactionId, 1),
      (error: unknown) => {
        assert.ok(error instanceof ContentError)
        assert.equal(error.code, "INTERACTION_STALE")
        assert.match(error.message, /当前已有唯一下一步/)
        return true
      },
    )
  })
})

test("STALE-07 端到端：导航刷新失败也把交互置终态", async () => {
  const seed = await seedCommon()
  await run(async () => {
    await updateItem(seed.itemA.id, { name: seed.itemA.name, description: "", appearance: "", acquisition: "", effects: [], attributes: [] })
    await assert.rejects(
      beginChatRequest(seed.scope.userId, {
        clientRequestId: `answer-${randomUUID()}`,
        conversationId: seed.conversation.id,
        interaction: { turnId: seed.turn.id, id: seed.interactionId, revision: 1, action: "answer" },
        storySelection: { kind: "choice", choiceId: seed.sceneChoiceId },
        message: "生成场景",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError)
        assert.equal(error.code, "INTERACTION_STALE")
        return true
      },
    )
    const panel = await prisma.chatTurn.findUniqueOrThrow({ where: { id: seed.turn.id } })
    assert.equal(panel.status, "succeeded")
    assert.equal((panel.interaction as { state?: string } | null)?.state, "skipped")
  })
})
