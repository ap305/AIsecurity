/** Offline release-bundle checks. Does not contact the API or execute course code. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import AdmZip from 'adm-zip'
import { loadCoursePack, sha256 } from './importCoursePackV3.js'
import {
  validateManifest,
  validateComposeDeclaration,
  decodeEvaluationArchive,
} from '../src/lib/evaluationPackage.js'

const manifestFile = process.argv[2]
if (!manifestFile) throw new Error('Expected manifest path; optionally --check-archives')
const { manifest, root, manifestDigest } = loadCoursePack(path.resolve(manifestFile))
const checkArchives = process.argv.includes('--check-archives')
let files = 0,
  publicResources = 0,
  totalBytes = 0
const packageSizes: Array<{ key: string; expandedBytes: number; compressedBytes?: number }> = []
for (const pkg of manifest.packages) {
  const directory = path.resolve(root, pkg.directory)
  const raw = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const config = validateManifest(raw, [raw.image])
  validateComposeDeclaration(fs.readFileSync(path.join(directory, 'compose.yaml'), 'utf8'), config)
  const names = new Set(pkg.files.map((file) => file.path))
  assert.ok(names.has(config.entrypoint), 'Grader entrypoint must be present')
  for (const file of config.worker?.files ?? [])
    assert.ok(names.has(file), 'Every worker mount must be present')
  const zip = checkArchives ? new AdmZip() : null
  let expandedBytes = 0
  for (const file of pkg.files) {
    const filename = path.join(directory, file.path)
    expandedBytes += fs.statSync(filename).size
    if (zip) zip.addFile(file.path, fs.readFileSync(filename))
    files++
  }
  const record: (typeof packageSizes)[number] = { key: pkg.key, expandedBytes }
  if (zip) {
    const archive = zip.toBuffer()
    record.compressedBytes = archive.length
    const decoded = decodeEvaluationArchive(archive)
    assert.equal(decoded.size, names.size)
    for (const file of pkg.files) assert.equal(sha256(decoded.get(file.path)!), file.sha256)
  }
  totalBytes += expandedBytes
  packageSizes.push(record)
}
for (const q of manifest.questions) {
  const filenames = new Set(q.resources.map((file) => file.filename))
  const prefix = `/api/questions/${q.id}/resources/`
  for (const match of q.content.matchAll(/\/api\/questions\/[^\s)"<>]+\/resources\/[^\s)"<>]+/g)) {
    assert.ok(match[0].startsWith(prefix), 'Question assets must belong to the same question')
    assert.ok(
      filenames.has(decodeURIComponent(match[0].slice(prefix.length))),
      'Question asset link must exist',
    )
  }
  publicResources += q.resources.length
}
console.log(
  JSON.stringify({
    status: 'passed',
    manifestDigest,
    questions: manifest.questions.length,
    packages: manifest.packages.length,
    files,
    publicResources,
    totalBytes,
    checkArchives,
    requiresCalibration: manifest.requiresCalibration,
    deploymentReady: manifest.deploymentReady,
    packageSizes,
  }),
)
