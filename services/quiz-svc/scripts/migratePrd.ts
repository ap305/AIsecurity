import fs from 'node:fs'
import { buildMigrationReport, applyBasicMigration } from '../src/services/prdMigration.js'
import { prisma } from '../src/lib/db.js'

// Explicit DATABASE_URL is required: this command never loads a repository .env automatically.
if (!process.env.DATABASE_URL) throw new Error('请显式提供待演练数据库 DATABASE_URL')
const apply = process.argv.includes('--apply')
const destination =
  process.argv.find((x) => x.startsWith('--report='))?.slice('--report='.length) ||
  'prd-migration-report.json'
let reportFile: number | undefined
try {
  // Reserve the report before any write transaction. An existing/unwritable destination must not allow a silent migration.
  reportFile = fs.openSync(destination, 'wx', 0o600)
  fs.writeFileSync(
    reportFile,
    JSON.stringify(
      { status: 'in_progress', mode: apply ? 'apply' : 'preview', startedAt: new Date().toISOString() },
      null,
      2,
    ),
  )
  fs.fsyncSync(reportFile)
  const report = apply ? await applyBasicMigration('migration-cli') : await buildMigrationReport()
  fs.ftruncateSync(reportFile, 0)
  fs.writeSync(reportFile, JSON.stringify(report, null, 2), 0, 'utf8')
  fs.fsyncSync(reportFile)
  console.log(
    `迁移${apply ? '完成' : '预览完成'}，差异报告已保存，基础成绩 ${report.scores.length} 条；待转换题目 ${report.questionsNeedingPackages.length} 道`,
  )
} finally {
  if (reportFile !== undefined) fs.closeSync(reportFile)
  await prisma.$disconnect()
}
