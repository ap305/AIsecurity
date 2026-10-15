import { createTestDatabase } from '../tests/database.js'
const database = await createTestDatabase()
const { prisma } = await import('../src/lib/db.js')
const { hashPassword } = await import('../src/lib/auth.js')
const { normalizeDefinition } = await import('../src/lib/prdContract.js')
const { app } = await import('../src/app.js')
await prisma.user.createMany({
  data: [
    {
      id: 'preview-student',
      username: 'preview',
      displayName: '测试学生',
      password: hashPassword('Preview_20261014!'),
      role: 'student',
      school: '测试学校',
      studentId: '001001',
    },
    {
      id: 'preview-admin',
      username: 'previewadmin',
      displayName: '测试管理员',
      password: hashPassword('Preview_20261014!'),
      role: 'admin',
    },
  ],
})
await prisma.apiPool.create({
  data: {
    id: 'qwen3-8b-default',
    name: 'Qwen3-8B（待配置服务）',
    kind: 'llm',
    model: 'qwen3-8b',
    modelVersion: 'preview-v1',
    baseUrl: 'http://127.0.0.1:8000/v1',
    enabled: false,
    isDefault: true,
  },
})
for (const item of [
  { id: 'SUM', title: '数组求和', category: 'basic', role: null, scenarioId: null },
  {
    id: 'ARENA-ATK',
    title: '文本过滤 · 攻击',
    category: 'adversarial',
    role: 'attack',
    scenarioId: 'text-filter',
  },
  {
    id: 'ARENA-DEF',
    title: '文本过滤 · 防御',
    category: 'adversarial',
    role: 'defense',
    scenarioId: 'text-filter',
  },
]) {
  const definition = normalizeDefinition({
    evaluation: { packageId: 'preview-package', baselineThreshold: 0.5 },
  })
  const row = await prisma.question.create({
    data: {
      ...item,
      moduleCode: 'ALGO',
      number: 1,
      type: 'code',
      difficulty: 'L1',
      definition: JSON.stringify(definition),
      content:
        '# 任务说明\n\n完成指定函数。\n\n## 输入输出\n\n输入一个整数数组，返回元素之和。\n\n```python\nsolve([1, 2, 3]) == 6\n```\n\n评分公式：$s = n_{pass} / n_{all} \\times 100$。\n',
      answerTemplate:
        '# 请只修改填空区\n# BEGIN STUDENT\ndef solve(values):\n    return sum(values)\n# END STUDENT\n',
    },
  })
  await prisma.questionRevision.create({
    data: {
      questionId: row.id,
      revision: 1,
      snapshot: JSON.stringify({
        questionId: row.id,
        questionVersion: 1,
        category: row.category,
        role: row.role,
        scenarioId: row.scenarioId,
        evaluationVersion: 'v1',
        definition,
      }),
    },
  })
}
await prisma.basicTotal.create({
  data: {
    userId: 'preview-student',
    totalScore: 85,
    tasksCompleted: 1,
    scoreReachedAt: new Date('2026-10-14T03:00:00Z'),
  },
})
const server = app.listen(4052, '127.0.0.1', () =>
  console.log(
    'Disposable PRD preview: http://127.0.0.1:4052; student preview, admin previewadmin. Password is the fixture value in this script. Queue intentionally remains paused.',
  ),
)
process.once('SIGINT', () =>
  server.close(() => {
    void prisma
      .$disconnect()
      .then(() => database.close())
      .then(() => process.exit(0))
  }),
)
