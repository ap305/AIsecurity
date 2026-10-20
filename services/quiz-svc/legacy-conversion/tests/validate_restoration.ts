/** Validate a materialized private restoration with the production ZIP importer. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { importEvaluationArchive, readEvaluationPackage } from '../../src/lib/evaluationPackage.js'
import { LEGACY_QUESTION_IDS, validateLegacyRecords } from '../../src/lib/legacyConversion.js'

const [directory, output, image] = process.argv.slice(2)
assert.ok(directory && output && image, 'directory output immutable-image required')
const root = path.resolve(directory)
process.env.EVALUATION_ALLOWED_IMAGES = image
process.env.EVALUATION_REQUIRE_IMAGE_DIGEST = '1'
const rows = validateLegacyRecords([
  ...JSON.parse(fs.readFileSync(path.join(root, 'bots/metadata.json'), 'utf8')),
  ...JSON.parse(fs.readFileSync(path.join(root, 'ml/questions.json'), 'utf8')),
])
assert.deepEqual(rows.map(row => row.questionId).sort(), [...LEGACY_QUESTION_IDS].sort())
const local = (absolute: string) => {
  assert.ok(absolute.startsWith('/courses/legacy20/'))
  const result = path.resolve(root, absolute.slice('/courses/legacy20/'.length))
  assert.ok(result.startsWith(root + path.sep))
  return result
}
const imported = new Map<string, any>()
for (const row of rows) {
  const packagePath = local(row.packageDirectory)
  assert.equal(fs.readFileSync(local(row.referenceCodePath), 'utf8'), row.solution)
  if (imported.has(packagePath)) continue
  const zip = new AdmZip()
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name)
      assert.equal(entry.isSymbolicLink(), false)
      if (entry.isDirectory()) walk(file)
      else {
        assert.ok(entry.isFile())
        zip.addFile(path.relative(packagePath, file).split(path.sep).join('/'), fs.readFileSync(file))
      }
    }
  }
  walk(packagePath)
  const bytes = zip.toBuffer()
  const record = await importEvaluationArchive(bytes, path.join(output, 'imported'))
  const read = await readEvaluationPackage(record.id, path.join(output, 'imported'))
  assert.equal(read.digest, record.digest)
  assert.equal(record.manifest.image, image)
  assert.ok(record.manifest.worker?.files.every(file => file.startsWith('public/')))
  assert.ok(!record.manifest.worker?.files.some(file => /evaluation-order|seed|original_test|\.npz$/.test(file)))
  imported.set(packagePath, { scenario: row.scenarioId, digest: record.digest, files: zip.getEntries().length,
    archiveBytes: bytes.length, archiveSha256: crypto.createHash('sha256').update(bytes).digest('hex') })
}
assert.equal(imported.size, 10)
fs.mkdirSync(output, { recursive: true })
const result = { questions: rows.length, packages: imported.size, productionImporter: 'passed',
  image, records: [...imported.values()] }
fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ questions: rows.length, packages: imported.size, productionImporter: 'passed' }))
