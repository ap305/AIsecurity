import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { validateEvaluationResult } from '../../../src/services/composeJudge.js'
import { validateManifest, validateComposeDeclaration } from '../../../src/lib/evaluationPackage.js'

const file = process.argv[2]
if (!file) throw new Error('Expected real RPC result-envelopes.json')
const envelopes = JSON.parse(fs.readFileSync(file, 'utf8'))
assert.equal(envelopes.length, 32)
let normalFailures = 0
for (const row of envelopes) {
  const result = validateEvaluationResult(row.result, row.input)
  assert.equal(result.status, 'completed')
  assert.ok(Object.values(result.metrics!).every((value) => typeof value === 'number' && Number.isFinite(value)))
  if (row.input.phase === 'opponent' && result.success === false) normalFailures++
}
assert.ok(normalFailures >= 9)
let packageManifests = 0
if (process.argv[3]) {
  const root = process.argv[3]
  const build = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  for (const row of build.packages) {
    const folder = path.join(root, row.directory)
    const raw = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'))
    const manifest = validateManifest(raw, [raw.image])
    validateComposeDeclaration(fs.readFileSync(path.join(folder, 'compose.yaml'), 'utf8'), manifest)
    packageManifests++
  }
  assert.equal(packageManifests, 32)
}
console.log(JSON.stringify({ status: 'passed', actualRpcEnvelopes: envelopes.length, normalFailures, packageManifests, productionValidator: true }))
