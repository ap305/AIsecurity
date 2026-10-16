import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { validateEvaluationResult } from '../../../src/services/composeJudge.js'
import { validateManifest, validateComposeDeclaration } from '../../../src/lib/evaluationPackage.js'

const [buildRoot, ...resultFolders] = process.argv.slice(2)
if (!buildRoot || !resultFolders.length) throw new Error('Expected build directory and real RPC result directories')
const build = JSON.parse(fs.readFileSync(path.join(buildRoot, 'manifest.json'), 'utf8'))
let completed = 0
for (const folder of resultFolders) {
  const input = JSON.parse(fs.readFileSync(path.join(folder, 'context.json'), 'utf8'))
  const raw = JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8'))
  assert.ok(input.parameters.sourceDigest, 'Production evaluation must expose frozen sourceDigest at the top level')
  assert.ok(input.parameters.version, 'Harness must pass the complete definition.evaluation')
  const result = validateEvaluationResult(raw, input)
  assert.equal(result.status, 'completed')
  assert.ok(Object.values(result.metrics!).every(value => typeof value === 'number' && Number.isFinite(value)))
  completed++
}
let packageManifests = 0
for (const row of build.packages) {
  const folder = path.join(buildRoot, row.directory)
  const raw = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'))
  const manifest = validateManifest(raw, [raw.image])
  validateComposeDeclaration(fs.readFileSync(path.join(folder, 'compose.yaml'), 'utf8'), manifest)
  packageManifests++
}
assert.equal(packageManifests, 4)
assert.equal(build.questions.length, 8)
console.log(JSON.stringify({ status: 'passed', actualRpcEnvelopes: completed, packageManifests, productionValidator: true }))
