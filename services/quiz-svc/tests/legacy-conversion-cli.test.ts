import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('Bot CLI reuses raw zero reference proofs, audits 1/n and re-verifies the changed formal definition', async () => {
  // Local HTTP protocol fixture, not a real-model acceptance result.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-bot-policy-cli-'))
  const posted: any[] = [],
    records = new Map<string, any>()
  const connections: Array<string | undefined> = []
  const server = http.createServer(async (request, response) => {
    try {
      connections.push(request.headers.connection)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      let data: any
      if (request.url === '/api/admin/api-pool') data = []
      else if (request.url?.startsWith('/api/admin/questions/'))
        data = {
          id: request.url.split('/').at(-1),
          status: 'published',
          judgeMode: 'managed',
          judgeVersion: 'v2',
          revision: 1,
          updatedAt: 'original',
        }
      else if (request.url === '/api/admin/evaluation-packages' || request.url?.endsWith('/validate'))
        data = { id: 'bot-package', digest: 'bot-digest' }
      else if (request.method === 'POST' && request.url?.endsWith('/self-tests')) {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        posted.push(input)
        const id = String(posted.length)
        data = {
          id,
          status: 'completed',
          result: {
            status: 'completed',
            cleanupStatus: 'cleaned',
            success: false,
            metrics: { qualificationMetric: 0, successMetric: 0, samples: 20 },
          },
        }
        records.set(id, data)
      } else if (request.method === 'GET' && request.url?.includes('/self-tests/'))
        data = records.get(request.url.split('/').at(-1)!)
      else throw new Error(`Unexpected fixture route: ${request.method} ${request.url}`)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ code: 0, data }))
    } catch (error) {
      response.statusCode = 500
      response.end(JSON.stringify({ code: 1, message: String(error) }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const packageDirectory = path.join(directory, 'package')
    fs.mkdirSync(packageDirectory)
    fs.writeFileSync(path.join(packageDirectory, 'main.py'), '# fixture')
    const metadata = ['attack', 'defense'].map((role) => {
      const code = `# official ${role}\npass\n`,
        referenceCodePath = path.join(directory, `${role}.py`)
      fs.writeFileSync(referenceCodePath, code)
      return {
        questionId: `CHATOPS-AD-${role === 'attack' ? 'ATK' : 'DEF'}`,
        scenarioId: 'chatops',
        role,
        title: 'fixture',
        content: 'fixture',
        answerTemplate: 'pass',
        solution: code,
        packageDirectory,
        referenceCodePath,
        calibrationRequired: true,
        calibration: { baseline: 'reference', opponent: 'reference' },
        provenance: { sourceVersion: 'v2', samples: 20 },
        definition: {
          kind: 'algorithm',
          weights: {},
          teacherApi: {},
          llm: { enabled: false },
          evaluation: {
            baselineMetric: 'qualificationMetric',
            successMetric: 'successMetric',
            samples: 20,
            timeoutMs: 1000,
          },
        },
      }
    })
    const metadataFile = path.join(directory, 'metadata.json'),
      stateFile = path.join(directory, 'state.json'),
      tokenFile = path.join(directory, 'token')
    fs.writeFileSync(metadataFile, JSON.stringify(metadata))
    fs.writeFileSync(tokenFile, 'local-fixture-token')
    const port = (server.address() as import('node:net').AddressInfo).port
    const run = (stage: string) =>
      new Promise<{ success: boolean; output: string }>((resolve) => {
        execFile(
          process.execPath,
          [
            path.join(root, 'node_modules/tsx/dist/cli.mjs'),
            path.join(root, 'scripts/convertLegacyQuestions.ts'),
            '--metadata',
            metadataFile,
            '--api',
            `http://127.0.0.1:${port}/api`,
            '--token-file',
            tokenFile,
            '--state',
            stateFile,
            '--stage',
            stage,
            '--only',
            'CHATOPS-AD-ATK',
          ],
          { cwd: root, timeout: 15000, windowsHide: true },
          (error, stdout, stderr) => resolve({ success: !error, output: stdout + stderr }),
        )
      })
    let outcome = await run('calibrate')
    assert.equal(outcome.success, true, outcome.output)
    let state = JSON.parse(fs.readFileSync(stateFile, 'utf8')),
      q = state.questions['CHATOPS-AD-ATK']
    assert.equal(posted.length, 2)
    const originalProofs = structuredClone(q.calibration)
    // Resume an old checkpoint without codeDigest/new policy evidence, preserving its raw zero.
    for (const phase of ['baseline', 'opponent']) {
      delete q.calibration[phase].codeDigest
      delete q.calibration[phase].source
    }
    q.definition.evaluation.successThreshold = 0
    delete q.calibrationEvidence.opponentThreshold
    q.verification = structuredClone(originalProofs)
    for (const phase of ['baseline', 'opponent'])
      q.verification[phase].configuration = 'old-formal-zero-threshold'
    q.verifiedAt = 'old-verification'
    fs.writeFileSync(stateFile, JSON.stringify(state))
    outcome = await run('verify')
    assert.equal(outcome.success, false)
    assert.equal(posted.length, 2)
    outcome = await run('calibrate')
    assert.equal(outcome.success, true, outcome.output)
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    q = state.questions['CHATOPS-AD-ATK']
    assert.equal(posted.length, 2, 'original reference measurements must be reused')
    assert.equal(q.calibration.opponent.id, originalProofs.opponent.id)
    assert.equal(q.calibration.opponent.configuration, originalProofs.opponent.configuration)
    assert.equal(q.calibration.opponent.record.result.metrics.successMetric, 0)
    assert.equal(q.definition.evaluation.baselineThreshold, 0)
    assert.equal(q.definition.evaluation.successThreshold, 1 / 20)
    assert.equal(q.calibrationEvidence.opponentThreshold.policy, 'user_approved_bot_zero_reference_one_win')
    assert.equal(q.calibrationEvidence.opponentThreshold.observed, 0)
    assert.equal(q.calibrationEvidence.opponentThreshold.samples, 20)
    outcome = await run('verify')
    assert.equal(outcome.success, true, outcome.output)
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    q = state.questions['CHATOPS-AD-ATK']
    assert.equal(posted.length, 4)
    assert.equal(q.verificationHistory[0].verifiedAt, 'old-verification')
    assert.equal(q.verification.opponent.record.result.success, false)
    assert.equal(posted[3].definition.evaluation.successThreshold, 1 / 20)
    assert.ok(q.verifiedAt)
    const verifiedState = structuredClone(state)
    for (const change of [
      (candidate: any) => {
        candidate.evaluation.baselineMetric = 'successMetric'
      },
      (candidate: any) => {
        candidate.evaluation.successMetric = 'qualificationMetric'
      },
      (candidate: any) => {
        candidate.evaluation.parameters = { seed: 99 }
      },
      (candidate: any) => {
        candidate.evaluation.packageId = 'unbound-package'
      },
      (candidate: any) => {
        candidate.llm = { enabled: true, poolId: 'unbound-model' }
      },
    ]) {
      const changed = structuredClone(verifiedState)
      change(changed.questions['CHATOPS-AD-ATK'].definition)
      fs.writeFileSync(stateFile, JSON.stringify(changed))
      outcome = await run('verify')
      assert.equal(outcome.success, false, 'changed definition must not start a new verification')
      assert.match(outcome.output, /冻结门槛|冻结评测包/)
      assert.equal(posted.length, 4)
    }
    q.definition.evaluation.successThreshold = 0.01
    fs.writeFileSync(stateFile, JSON.stringify(state))
    outcome = await run('verify')
    assert.equal(outcome.success, false)
    assert.match(outcome.output, /冻结门槛/)
    q.definition.evaluation.successThreshold = 1 / 20
    delete q.calibrationEvidence.opponentThreshold
    fs.writeFileSync(stateFile, JSON.stringify(state))
    outcome = await run('verify')
    assert.equal(outcome.success, false)
    assert.match(outcome.output, /决议证据/)
    assert.equal(posted.length, 4)
    assert.ok(connections.length > 0 && connections.every(connection => connection === 'close'), 'conversion requests must not reuse sockets after synchronous archive work')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI keeps official calibration and requires the exact acceptance source to pass fixed qualification', async () => {
  // HTTP contract fixture only; actual Docker/model acceptance is performed separately.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-conversion-cli-'))
  const posted: any[] = []
  const records = new Map<string, any>()
  const packages = new Map<string, any>()
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      let data: any
      if (request.url === '/api/admin/api-pool') data = []
      else if (request.url?.startsWith('/api/admin/questions/'))
        data = {
          id: request.url.split('/').at(-1),
          status: 'published',
          judgeMode: 'managed',
          judgeVersion: 'v2',
          revision: 1,
          updatedAt: 'original',
        }
      else if (request.url === '/api/admin/evaluation-packages') {
        const id = `package-${packages.size + 1}`
        data = { id, digest: `digest-${id}` }
        packages.set(id, data)
      } else if (request.url?.endsWith('/validate')) data = packages.get(request.url.split('/').at(-2)!)
      else if (request.method === 'POST' && request.url?.endsWith('/self-tests')) {
        const input = JSON.parse(body.toString('utf8'))
        posted.push(input)
        const id = String(posted.length)
        const result = {
          status: 'completed',
          cleanupStatus: 'cleaned',
          metrics: {
            qualificationMetric: input.code.includes('acceptance-good') ? 0.05 : 0.01,
            successMetric: input.definition.evaluation.calibrationMode ? 0.4 : 0,
          },
        }
        data = { id, status: 'completed', result }
        records.set(id, data)
      } else if (request.method === 'GET' && request.url?.includes('/self-tests/'))
        data = records.get(request.url.split('/').at(-1)!)
      else throw new Error(`Unexpected fixture route: ${request.method} ${request.url}`)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ code: 0, data }))
    } catch (error) {
      response.statusCode = 500
      response.end(JSON.stringify({ code: 1, message: String(error) }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const packageDirectory = path.join(directory, 'package')
    fs.mkdirSync(packageDirectory)
    fs.writeFileSync(path.join(packageDirectory, 'main.py'), '# fixture package')
    const officialAttack = '# official-attack\ndef attack(): pass\n'
    const officialDefense = '# official-defense\ndef defend(): pass\n'
    const acceptanceCode = '# acceptance-good\ndef attack(): pass\n'
    const attackPath = path.join(directory, 'attack.py')
    const defensePath = path.join(directory, 'defense.py')
    const acceptancePath = path.join(directory, 'acceptance.py')
    fs.writeFileSync(attackPath, officialAttack)
    fs.writeFileSync(defensePath, officialDefense)
    fs.writeFileSync(acceptancePath, acceptanceCode)
    const metadata = ['attack', 'defense'].map((role) => ({
      questionId: role === 'attack' ? 'MNIST-POISON' : 'MNIST-POISON-DEF',
      scenarioId: 'mnist_poison',
      role,
      title: 'fixture',
      content: 'fixture',
      answerTemplate: 'pass',
      solution: role === 'attack' ? officialAttack : officialDefense,
      packageDirectory,
      referenceCodePath: role === 'attack' ? attackPath : defensePath,
      calibrationRequired: true,
      calibration: { baseline: 'fixed', baselineThreshold: 0.05, opponent: 'reference' },
      provenance: { sourceVersion: 'v2' },
      definition: {
        kind: 'algorithm',
        weights: {},
        teacherApi: {},
        llm: { enabled: false },
        evaluation: {
          baselineMetric: 'qualificationMetric',
          successMetric: 'successMetric',
          timeoutMs: 1000,
        },
      },
    }))
    const metadataFile = path.join(directory, 'metadata.json')
    let activeMetadataFile = metadataFile
    const acceptanceFile = path.join(directory, 'acceptance.json')
    const stateFile = path.join(directory, 'state.json')
    const tokenFile = path.join(directory, 'token')
    fs.writeFileSync(metadataFile, JSON.stringify(metadata))
    fs.writeFileSync(acceptanceFile, JSON.stringify({ 'MNIST-POISON': 'acceptance.py' }))
    fs.writeFileSync(tokenFile, 'local-fixture-token')
    const port = (server.address() as import('node:net').AddressInfo).port
    const run = (stage: string, extra: string[] = [], fullScope = false) =>
      new Promise<{ success: boolean; output: string }>((resolve) => {
        execFile(
          process.execPath,
          [
            path.join(root, 'node_modules/tsx/dist/cli.mjs'),
            path.join(root, 'scripts/convertLegacyQuestions.ts'),
            '--metadata',
            activeMetadataFile,
            '--api',
            `http://127.0.0.1:${port}/api`,
            '--token-file',
            tokenFile,
            '--state',
            stateFile,
            '--stage',
            stage,
            ...(fullScope ? [] : ['--only', 'MNIST-POISON']),
            '--acceptance',
            acceptanceFile,
            ...extra,
          ],
          { cwd: root, timeout: 15000, windowsHide: true },
          (error, stdout, stderr) => resolve({ success: !error, output: stdout + stderr }),
        )
      })
    let runResult = await run('calibrate')
    assert.equal(runResult.success, true, runResult.output)
    assert.equal(posted.length, 2)
    assert.equal(posted[0].code, officialAttack)
    assert.equal(posted[1].code, officialAttack)
    assert.equal(posted[1].opponent.code, officialDefense)
    let state = JSON.parse(fs.readFileSync(stateFile, 'utf8')).questions['MNIST-POISON']
    assert.equal(state.definition.evaluation.baselineThreshold, 0.05)
    assert.equal(state.definition.evaluation.successThreshold, 0.4)
    assert.equal(state.calibrationStatus, 'requires_acceptance')
    assert.equal(state.calibrationEvidence.referenceBaseline.readyToPublish, false)
    assert.equal(state.verifiedAt, undefined)

    runResult = await run('verify')
    assert.equal(runResult.success, true, runResult.output)
    assert.equal(posted.length, 4)
    assert.equal(posted[2].code, acceptanceCode)
    assert.equal(posted[3].code, acceptanceCode)
    assert.equal(posted[3].opponent.code, officialDefense)
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8')).questions['MNIST-POISON']
    const digest = crypto.createHash('sha256').update(acceptanceCode).digest('hex')
    assert.equal(state.verification.baseline.codeDigest, digest)
    assert.equal(state.verification.opponent.codeDigest, digest)
    assert.equal(state.verifiedMaterial.source, 'acceptance')
    assert.ok(state.verifiedAt)
    assert.equal(state.verification.opponent.record.result.metrics.successMetric, 0)

    // Changing the example archives old proofs and cannot retain a previous ready timestamp.
    fs.writeFileSync(acceptancePath, '# acceptance-bad\ndef attack(): pass\n')
    runResult = await run('verify')
    assert.equal(runResult.success, false)
    assert.match(runResult.output, /did not pass/)
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8')).questions['MNIST-POISON']
    assert.equal(state.verifiedAt, undefined)
    assert.equal(state.verificationHistory.length, 1)
    assert.equal(state.definition.evaluation.baselineThreshold, 0.05)
    assert.equal(state.calibration.baseline.record.result.metrics.qualificationMetric, 0.01)
    assert.equal(state.verification.opponent, undefined)
    assert.equal(posted.length, 5)

    // Unknown mappings fail before the first HTTP mutation.
    fs.writeFileSync(acceptanceFile, JSON.stringify({ UNKNOWN: 'acceptance.py' }))
    runResult = await run('verify')
    assert.equal(runResult.success, false)
    assert.match(runResult.output, /未授权/)
    assert.equal(posted.length, 5)

    fs.writeFileSync(acceptanceFile, JSON.stringify({ 'MNIST-POISON': 'acceptance.py' }))
    const relocatedPackage = path.join(directory, 'new-output', 'package')
    fs.mkdirSync(relocatedPackage, { recursive: true })
    fs.copyFileSync(path.join(packageDirectory, 'main.py'), path.join(relocatedPackage, 'main.py'))
    const nextMetadata = metadata.map((row) => ({ ...row, packageDirectory: relocatedPackage }))
    activeMetadataFile = path.join(directory, 'new-metadata.json')
    fs.writeFileSync(activeMetadataFile, JSON.stringify(nextMetadata))
    // tag02 calibration proofs have only id/configuration/record, without newer material fields.
    const legacyCheckpoint = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    for (const phase of ['baseline', 'opponent']) {
      delete legacyCheckpoint.questions['MNIST-POISON'].calibration[phase].codeDigest
      delete legacyCheckpoint.questions['MNIST-POISON'].calibration[phase].source
    }
    fs.writeFileSync(stateFile, JSON.stringify(legacyCheckpoint, null, 2))
    const beforeRefresh = fs.readFileSync(stateFile, 'utf8')
    runResult = await run('prepare', [], true)
    assert.equal(runResult.success, false)
    assert.match(runResult.output, /metadata revision/)
    assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeRefresh)
    runResult = await run('prepare', ['--refresh-from', activeMetadataFile], true)
    assert.equal(runResult.success, false)
    assert.match(runResult.output, /cannot rewrite its hash/)
    assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeRefresh)

    // An active task or incomplete cleanup blocks the whole refresh without touching the checkpoint.
    const latest = records.get('5')!
    latest.status = 'running'
    runResult = await run('prepare', ['--refresh-from', metadataFile], true)
    assert.equal(runResult.success, false)
    assert.match(runResult.output, /active or unclean/)
    assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeRefresh)
    latest.status = 'completed'
    latest.result.cleanupStatus = 'failed'
    runResult = await run('prepare', ['--refresh-from', metadataFile], true)
    assert.equal(runResult.success, false)
    assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeRefresh)
    latest.result.cleanupStatus = 'cleaned'

    runResult = await run('prepare', ['--refresh-from', metadataFile], true)
    assert.equal(runResult.success, true, runResult.output)
    let fullState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    state = fullState.questions['MNIST-POISON']
    assert.deepEqual(fullState.refreshHistory.at(-1).reused, ['MNIST-POISON'])
    assert.equal(state.calibration.baseline.id, '1')
    assert.equal(state.calibration.opponent.id, '2')
    assert.equal(state.calibration.baseline.codeDigest, undefined)
    assert.equal(state.verification.baseline.id, '5')
    assert.match(state.error, /did not pass/)
    assert.equal(state.verifiedAt, undefined)
    assert.equal(packages.size, 1)
    assert.equal(posted.length, 5)

    // A file-content change requires a new package and clears current evidence, while archiving errors.
    fs.writeFileSync(path.join(relocatedPackage, 'main.py'), '# changed grader implementation')
    runResult = await run('prepare', ['--refresh-from', activeMetadataFile], true)
    assert.equal(runResult.success, true, runResult.output)
    fullState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    state = fullState.questions['MNIST-POISON']
    assert.equal(state.calibration, undefined)
    assert.equal(state.verification, undefined)
    assert.equal(state.verifiedAt, undefined)
    assert.equal(state.definition, undefined)
    assert.equal(state.packageId, 'package-2')
    assert.equal(state.before.revision, 1)
    assert.match(state.priorError, /did not pass/)
    const archived = fullState.refreshHistory
      .at(-1)
      .invalidated.find((item: any) => item.questionId === 'MNIST-POISON')
    assert.ok(archived.reasons.includes('package_files_changed'))
    assert.equal(archived.previous.calibration.baseline.id, '1')
    assert.match(archived.previous.error, /did not pass/)
    assert.equal(packages.size, 2)
    assert.equal(posted.length, 5)

    runResult = await run('calibrate')
    assert.equal(runResult.success, true, runResult.output)
    fullState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    fullState.questions['MNIST-POISON'].calibration.baseline.configuration = 'mismatched-fingerprint'
    fs.writeFileSync(stateFile, JSON.stringify(fullState, null, 2))
    runResult = await run('prepare', ['--refresh-from', activeMetadataFile], true)
    assert.equal(runResult.success, true, runResult.output)
    fullState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(fullState.questions['MNIST-POISON'].calibration, undefined)
    assert.ok(
      fullState.refreshHistory
        .at(-1)
        .invalidated[0].reasons.includes('calibration_baseline_configuration_changed'),
    )
    assert.equal(packages.size, 2)

    runResult = await run('calibrate')
    assert.equal(runResult.success, true, runResult.output)
    fs.writeFileSync(defensePath, officialDefense + '# changed opposite-role material\n')
    runResult = await run('prepare', ['--refresh-from', activeMetadataFile], true)
    assert.equal(runResult.success, true, runResult.output)
    fullState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(fullState.questions['MNIST-POISON'].calibration, undefined)
    const oppositeChange = fullState.refreshHistory.at(-1).invalidated
    assert.ok(
      oppositeChange
        .find((item: any) => item.questionId === 'MNIST-POISON')
        .reasons.includes('calibration_opponent_configuration_changed'),
    )
    assert.ok(
      oppositeChange
        .find((item: any) => item.questionId === 'MNIST-POISON-DEF')
        .reasons.includes('official_reference_changed'),
    )
    assert.equal(packages.size, 2)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
