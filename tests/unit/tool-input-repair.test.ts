import assert from "node:assert/strict"
import { test } from "node:test"
import { tool, type ToolSet } from "ai"
import { z } from "zod"
import { normalizeToolInput, repairToolInput, toolInputIssueHint } from "../../src/lib/ai/tool-input-repair"

const bigFiveSchema = z
  .object({
    openness: z.number().int().min(0).max(100),
    conscientiousness: z.number().int().min(0).max(100),
    extraversion: z.number().int().min(0).max(100),
    agreeableness: z.number().int().min(0).max(100),
    neuroticism: z.number().int().min(0).max(100),
  })
  .nullable()

const updateCharacter = tool({
  inputSchema: z.object({ characterId: z.string(), bigFive: bigFiveSchema.optional() }),
  execute: async () => ({ ok: true }),
})

const createCharacter = tool({
  inputSchema: z.object({ name: z.string(), roleType: z.enum(["PROTAGONIST", "SUPPORTING", "ANTAGONIST"]), bigFive: bigFiveSchema.default(null) }),
  execute: async () => ({ ok: true }),
})

const tools = { updateCharacter, createCharacter } as unknown as ToolSet
const bigFiveValue = { openness: 78, conscientiousness: 86, extraversion: 32, agreeableness: 44, neuroticism: 56 }

function inputSchemaFor(name: string) {
  const schema = (tools as unknown as Record<string, { inputSchema: z.ZodType }>)[name].inputSchema
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" })
}

async function repair(name: string, input: unknown) {
  const repaired = await repairToolInput({
    toolCall: { toolCallId: "call_fixture", toolName: name, input: JSON.stringify(input) },
    tools,
    inputSchema: async ({ toolName }: { toolName: string }) => inputSchemaFor(toolName),
  } as never)
  return repaired ? JSON.parse(repaired.input) : null
}

test("对象字段被编码为 JSON 字符串时还原为对象", () => {
  const repaired = normalizeToolInput({ bigFive: JSON.stringify(bigFiveValue) }, inputSchemaFor("updateCharacter"))
  assert.deepEqual(repaired, { bigFive: bigFiveValue })
})

test("数组字段被编码为 JSON 字符串时还原为数组", () => {
  const schema = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } }
  assert.deepEqual(normalizeToolInput({ tags: '["内向","INTP"]' }, schema), { tags: ["内向", "INTP"] })
})

test("普通字符串字段即使内容像 JSON 也保持原样", () => {
  const schema = { type: "object", properties: { note: { type: "string" } } }
  const note = '{"openness":78}'
  assert.deepEqual(normalizeToolInput({ note }, schema), { note })
})

test("无效 JSON 或类型不匹配的字符串不做臆造修复", () => {
  const objectSchema = { type: "object", properties: { bigFive: { type: "object", properties: { openness: { type: "number" } } } } }
  assert.deepEqual(normalizeToolInput({ bigFive: "{oops" }, objectSchema), { bigFive: "{oops" })
  assert.deepEqual(normalizeToolInput({ bigFive: "[1,2]" }, objectSchema), { bigFive: "[1,2]" })
})

test("联合同时允许字符串时不改动原文", () => {
  const schema = { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "object", properties: { a: { type: "number" } } }] } } }
  const value = '{"a":1}'
  assert.deepEqual(normalizeToolInput({ value }, schema), { value })
})

test("还原后按命中的联合分支继续规整内部字段", () => {
  const schema = { type: "object", properties: { bigFive: { anyOf: [{ type: "object", properties: { openness: { type: "number" } } }, { type: "null" }] } } }
  assert.deepEqual(normalizeToolInput({ bigFive: '{"openness":"78"}' }, schema), { bigFive: { openness: 78 } })
})

test("repairToolInput 修复 updateCharacter 的字符串化 bigFive", async () => {
  const input = await repair("updateCharacter", { characterId: "character_1", bigFive: JSON.stringify(bigFiveValue) })
  assert.deepEqual(input, { characterId: "character_1", bigFive: bigFiveValue })
  const parsed = (updateCharacter.inputSchema as unknown as z.ZodType).safeParse(input)
  assert.equal(parsed.success, true)
})

test("错误提示按实际值区分缺失与类型不符", () => {
  assert.equal(toolInputIssueHint(tools, "updateCharacter", { characterId: "character_1", bigFive: JSON.stringify(bigFiveValue) }), "bigFive: 应为对象，实际为字符串")
  assert.equal(toolInputIssueHint(tools, "updateCharacter", { bigFive: null }), "缺少 characterId")
  assert.equal(toolInputIssueHint(tools, "createCharacter", { roleType: "PROTAGONIST" }), "缺少 name")
  assert.equal(toolInputIssueHint(tools, "updateCharacter", "not-an-object"), "(整体): 应为对象，实际为字符串")
})

test("缺省 bigFive 的合法输入不产生错误提示", () => {
  assert.equal(toolInputIssueHint(tools, "createCharacter", { name: "角色甲", roleType: "PROTAGONIST" }), null)
})
