import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import {
  runComposeEvaluation,
  validateEvaluationResult,
  buildControlledCompose,
  recoverPendingComposeCleanups,
  PLATFORM_STUDENT_CLIENT_SOURCE,
  PLATFORM_STUDENT_WORKER_SOURCE,
  type CommandExecutor,
  type ComposeEvaluationInput,
} from '../src/services/composeJudge.js'
import {
  importEvaluationDirectory,
  EVALUATION_EXAMPLE_ROOT,
  validateManifest,
} from '../src/lib/evaluationPackage.js'

function input(packageId: string): ComposeEvaluationInput {
  return {
    submissionId: 'submission-1',
    attemptId: 'attempt-1',
    questionVersion: 1,
    evaluationVersion: 'v1',
    packageId,
    code: 'def solve(values): return sum(values)',
    filePath: null,
    phase: 'basic',
  }
}
function output(i: ComposeEvaluationInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submissionId: i.submissionId,
    attemptId: i.attemptId,
    questionVersion: i.questionVersion,
    evaluationVersion: i.evaluationVersion,
    phase: i.phase,
    status: 'completed',
    ...(i.phase === 'basic'
      ? { score: 80, maxScore: 100 }
      : i.phase === 'baseline'
        ? { metrics: { qualificationMetric: 0.5 } }
        : { opponentSubmissionId: i.opponent!.submissionId, success: false, metrics: { successMetric: 0 } }),
    ...extra,
  }
}
async function fixture(name = 'basic-algorithm') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-runner-'))
  const packages = path.join(root, 'packages'),
    workspaces = path.join(root, 'workspaces')
  const descriptor = await importEvaluationDirectory(path.join(EVALUATION_EXAMPLE_ROOT, name), packages)
  return { root, packages, workspaces, descriptor }
}
function mockExecutor(
  i: ComposeEvaluationInput,
  commands: string[][],
  options: {
    upTimeout?: boolean
    upFail?: boolean
    evaluatorFail?: boolean
    badResult?: boolean
    downFail?: boolean
    preflightFailure?: boolean
  } = {},
): CommandExecutor {
  let project = ''
  const containers = new Map<string, string>()
  const networks = new Map<string, string>()
  const digest = (name: string) => crypto.createHash('sha256').update(`${project}:${name}`).digest('hex')
  const address = (name: string) =>
    name === 'student' ? '172.29.1.2' : name === 'opponent' ? '172.29.2.2' : '172.29.3.2'
  return async (_binary, args, commandOptions) => {
    commands.push(args)
    if (args.includes('--project-name')) project = args[args.indexOf('--project-name') + 1]
    if (args.includes('ps')) {
      const service = args.at(-1)!
      const id = digest(service)
      containers.set(id, service)
      return { exitCode: 0, stdout: `${id}\n`, stderr: '' }
    }
    if (args[0] === 'inspect') {
      const id = args.at(-1)!,
        service = containers.get(id)!
      const lane = service === 'gateway' ? 'job-internal' : `${service}-lane`
      const networkId = digest(lane)
      networks.set(networkId, service)
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          id,
          project,
          service,
          running: true,
          health: 'healthy',
          networks: {
            [`${project}_${lane}`]: { NetworkID: networkId, IPAddress: address(service) },
            ...(service === 'gateway'
              ? {
                  [`${project}_gateway-egress`]: {
                    NetworkID: digest('gateway-egress'),
                    IPAddress: '172.29.4.2',
                  },
                }
              : {}),
          },
        }),
        stderr: '',
      }
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const id = args.at(-1)!,
        service = networks.get(id)!
      const lane = service === 'gateway' ? 'job-internal' : `${service}-lane`
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          id,
          name: `${project}_${lane}`,
          internal: true,
          project,
          network: lane,
          containers: { [digest(service)]: { IPv4Address: `${address(service)}/24` } },
        }),
        stderr: '',
      }
    }
    if (args.includes('up')) {
      if (args.includes('--no-deps')) {
        const c = JSON.parse(fs.readFileSync(path.join(commandOptions.cwd, 'input/context.json'), 'utf8'))
        assert.equal(c.attemptId, i.attemptId)
        assert.equal(c.student.url, `http://${address('student')}:9000`)
        if (i.opponent) assert.equal(c.opponent.url, `http://${address('opponent')}:9000`)
        if (i.modelGateway) assert.equal(c.modelGateway.url, `http://${address('gateway')}:8080/v1`)
      } else assert.equal(fs.existsSync(path.join(commandOptions.cwd, 'input/context.json')), false)
      assert.equal(
        fs.readFileSync(path.join(commandOptions.cwd, 'student/materials/code.py'), 'utf8'),
        i.code,
      )
      assert.equal(commandOptions.env.DATABASE_URL, undefined)
      return {
        exitCode: options.upFail || (options.evaluatorFail && args.includes('--no-deps')) ? 1 : 0,
        stdout: '',
        stderr: '',
        timedOut: options.upTimeout,
      }
    }
    if (args.includes('logs'))
      return {
        exitCode: 0,
        stdout: `student log\nPLATFORM_EVALUATION_RESULT:${JSON.stringify(output(i, options.badResult ? { attemptId: 'other-attempt' } : {}))}\n`,
        stderr: '',
      }
    if (args.includes('/worker/preflight.py')) return {
      exitCode: 0, stdout: JSON.stringify(options.preflightFailure ? {ok:false,reason:'incomplete',line:3} : {ok:true}), stderr:'',
    }
    assert.ok(args.includes('down'), `Unexpected Docker command ${args[0]}`)
    return { exitCode: options.downFail ? 1 : 0, stdout: '', stderr: '' }
  }
}
test('incomplete candidate stops before scoring/model calls and still cleans isolated resources', async () => {
  const f = await fixture()
  try {
    const i = { ...input(f.descriptor.id), answerTemplate: 'def solve(x): raise NotImplementedError("TODO")' }
    const commands: string[][] = []
    const result = await runComposeEvaluation(i, {
      executor: mockExecutor(i, commands, {preflightFailure:true}),
      packageRoot: f.packages, workspaceRoot: f.workspaces,
    })
    assert.equal(result.status, 'student_error')
    assert.match(result.publicMessage!, /第 3 行/)
    assert.equal(result.cleanupStatus, 'cleaned')
    assert.equal(commands.some(c => c.includes('up') && c.includes('--no-deps')), false)
    assert.equal(commands.some(c => c.includes('down')), true)
  } finally { fs.rmSync(f.root, {recursive:true, force:true}) }
})
test('isolated job invokes only generated Compose, validates result and cleans all artifacts', async () => {
  const f = await fixture()
  try {
    const i = input(f.descriptor.id),
      commands: string[][] = []
    const result = await runComposeEvaluation(i, {
      executor: mockExecutor(i, commands),
      packageRoot: f.packages,
      workspaceRoot: f.workspaces,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.score, 80)
    assert.equal(result.cleanupStatus, 'cleaned')
    assert.equal(commands.length, 8)
    assert.ok(commands[0].includes('--no-build'))
    assert.ok(commands[0].includes('never'))
    assert.ok(commands[0].includes('--wait'))
    assert.equal(commands[0].at(-1), 'student')
    assert.ok(commands[1].includes('/worker/preflight.py'))
    assert.ok(commands[2].includes('ps'))
    assert.equal(commands[3][0], 'inspect')
    assert.deepEqual(commands[4].slice(0, 2), ['network', 'inspect'])
    assert.ok(commands[5].includes('--no-deps'))
    assert.equal(commands[5].at(-1), 'evaluator')
    assert.ok(commands[6].includes('logs'))
    assert.ok(commands[7].includes('down'))
    assert.ok(commands[7].includes('--volumes'))
    assert.deepEqual(fs.readdirSync(f.workspaces), ['_cleanup'])
    assert.deepEqual(fs.readdirSync(path.join(f.workspaces, '_cleanup')), [])
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
test('timeout, startup failure and result spoofing each run project-scoped cleanup', async () => {
  const f = await fixture()
  try {
    const i = input(f.descriptor.id)
    for (const behavior of [
      { upTimeout: true },
      { upFail: true },
      { evaluatorFail: true },
      { badResult: true },
    ]) {
      const commands: string[][] = []
      const result = await runComposeEvaluation(i, {
        executor: mockExecutor(i, commands, behavior),
        packageRoot: f.packages,
        workspaceRoot: f.workspaces,
      })
      assert.equal(result.status, 'upTimeout' in behavior ? 'timeout' : 'system_error')
      assert.equal(result.cleanupStatus, 'cleaned')
      assert.ok(commands.at(-1)!.includes('down'))
      assert.ok(!commands.flat().includes('prune'))
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('discovered RPC addresses fail closed on wrong identity, wrong lane, unsafe IP or missing network membership', async () => {
  const f = await fixture()
  try {
    const corruptions = [
      'multiple-ids',
      'invalid-id',
      'wrong-id',
      'wrong-project',
      'wrong-service',
      'not-running',
      'not-healthy',
      'wrong-lane',
      'extra-network',
      'invalid-ip',
      'loopback-ip',
      'missing-network',
      'external-network',
      'foreign-network',
      'wrong-network-id',
      'wrong-member',
      'inspect-failure',
      'malformed-inspect',
    ]
    for (const corruption of corruptions) {
      const i = input(f.descriptor.id),
        commands: string[][] = []
      const base = mockExecutor(i, commands)
      const result = await runComposeEvaluation(i, {
        packageRoot: f.packages,
        workspaceRoot: f.workspaces,
        executor: async (binary, args, options) => {
          const response = await base(binary, args, options)
          if (args.includes('ps')) {
            if (corruption === 'multiple-ids')
              return { ...response, stdout: response.stdout + response.stdout }
            if (corruption === 'invalid-id') return { ...response, stdout: '--all' }
          }
          if (args[0] === 'inspect') {
            if (corruption === 'inspect-failure') return { ...response, exitCode: 1 }
            if (corruption === 'malformed-inspect') return { ...response, stdout: 'not-json' }
            const c = JSON.parse(response.stdout)
            if (corruption === 'wrong-id') c.id = 'f'.repeat(64)
            if (corruption === 'wrong-project') c.project = 'another-project'
            if (corruption === 'wrong-service') c.service = 'opponent'
            if (corruption === 'not-running') c.running = false
            if (corruption === 'not-healthy') c.health = 'starting'
            const lane = Object.keys(c.networks)[0]
            if (corruption === 'wrong-lane') c.networks = { wrong: c.networks[lane] }
            if (corruption === 'extra-network') c.networks.outside = c.networks[lane]
            if (corruption === 'invalid-ip') c.networks[lane].IPAddress = '172.20.0.2/24'
            if (corruption === 'loopback-ip') c.networks[lane].IPAddress = '127.0.0.1'
            if (corruption === 'missing-network') c.networks = {}
            return { ...response, stdout: JSON.stringify(c) }
          }
          if (args[0] === 'network') {
            const n = JSON.parse(response.stdout)
            if (corruption === 'external-network') n.internal = false
            if (corruption === 'foreign-network') n.project = 'another-project'
            if (corruption === 'wrong-network-id') n.id = 'f'.repeat(64)
            if (corruption === 'wrong-member') n.containers = {}
            return { ...response, stdout: JSON.stringify(n) }
          }
          return response
        },
      })
      assert.equal(result.status, 'system_error', corruption)
      assert.equal(result.cleanupStatus, 'cleaned', corruption)
      assert.ok(commands.at(-1)?.includes('down'), corruption)
      assert.equal(
        commands.some((c) => c.includes('--no-deps')),
        false,
        corruption,
      )
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('worker startup and inspect steps share one bounded deadline, with independent cleanup budget', async () => {
  const f = await fixture()
  try {
    const i = { ...input(f.descriptor.id), timeoutMs: 100 },
      commands: string[][] = [],
      budgets: number[] = []
    const base = mockExecutor(i, commands)
    const result = await runComposeEvaluation(i, {
      packageRoot: f.packages,
      workspaceRoot: f.workspaces,
      executor: async (binary, args, options) => {
        const response = await base(binary, args, options)
        if (!args.includes('down')) {
          budgets.push(options.timeoutMs)
          await new Promise((resolve) => setTimeout(resolve, 45))
        } else assert.equal(options.timeoutMs, 20000)
        return response
      },
    })
    assert.equal(result.status, 'timeout')
    assert.equal(result.cleanupStatus, 'cleaned')
    assert.ok(budgets.length >= 2)
    assert.ok(
      budgets.every(
        (value, index) => value > 0 && value <= 100 && (index === 0 || value < budgets[index - 1]),
      ),
    )
    assert.equal(
      commands.some((c) => c.includes('--no-deps')),
      false,
    )
    assert.ok(commands.at(-1)?.includes('down'))
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('gateway discovery uses its verified job-internal address, never its egress address or service DNS', async () => {
  const f = await fixture()
  try {
    const source = path.join(f.root, 'gateway-package')
    fs.cpSync(path.join(EVALUATION_EXAMPLE_ROOT, 'basic-algorithm'), source, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
    manifest.network = 'gateway'
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest))
    const descriptor = await importEvaluationDirectory(source, f.packages)
    const i = {
      ...input(descriptor.id),
      modelGateway: { url: 'http://host.docker.internal:4002/api/gateway', token: 'upstream-secret' },
    }
    const commands: string[][] = [],
      base = mockExecutor(i, commands)
    const result = await runComposeEvaluation(i, {
      packageRoot: f.packages,
      workspaceRoot: f.workspaces,
      executor: async (binary, args, options) => {
        if (args.includes('--no-deps')) {
          const context = JSON.parse(fs.readFileSync(path.join(options.cwd, 'input/context.json'), 'utf8'))
          assert.equal(context.modelGateway.url, 'http://172.29.3.2:8080/v1')
          assert.notEqual(context.modelGateway.token, i.modelGateway.token)
          const compose = JSON.parse(fs.readFileSync(path.join(options.cwd, 'compose.json'), 'utf8'))
          assert.deepEqual(compose.services.student.networks, ['student-lane'])
          assert.deepEqual(compose.services.gateway.networks, ['job-internal', 'gateway-egress'])
          assert.deepEqual(compose.services.evaluator.networks, ['student-lane', 'job-internal'])
        }
        return base(binary, args, options)
      },
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.cleanupStatus, 'cleaned')
    assert.equal(commands.length, 11)
    assert.equal(commands.filter((c) => c.includes('--no-deps')).length, 1)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('the isolated relay supports only the full original D02 expanded call budget', async () => {
  const f = await fixture()
  try {
    const source = path.join(f.root, 'gateway-budget-package')
    fs.cpSync(path.join(EVALUATION_EXAMPLE_ROOT, 'basic-algorithm'), source, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
    manifest.network = 'gateway'
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest))
    const descriptor = await importEvaluationDirectory(source, f.packages)
    for (const [samples, expected] of [[300, 3600], [20, 1000]]) {
      const i: ComposeEvaluationInput = {
        ...input(descriptor.id), role: 'defense',
        parameters: { version: 'v3-261012-d02-original300-v12', maxModelCalls: 3600,
          parameters: { number: '02', role: 'defense', samples } },
        modelGateway: { url: 'http://host.docker.internal:4002/api/gateway', token: 'fixture' },
      }
      const base = mockExecutor(i, [])
      const result = await runComposeEvaluation(i, {
        packageRoot: f.packages, workspaceRoot: f.workspaces,
        executor: async (binary, args, options) => {
          if (args.includes('--no-deps'))
            assert.equal(JSON.parse(fs.readFileSync(path.join(options.cwd, 'relay/context.json'), 'utf8')).maxCalls, expected)
          return base(binary, args, options)
        },
      })
      assert.equal(result.status, 'completed')
      assert.equal(result.cleanupStatus, 'cleaned')
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})

test('long D02 manifests cannot extend another evaluation beyond its ordinary deadline', async () => {
  const f = await fixture()
  try {
    const source = path.join(f.root, 'original-d02-long-package')
    fs.cpSync(path.join(EVALUATION_EXAMPLE_ROOT, 'basic-algorithm'), source, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
    Object.assign(manifest, { network: 'gateway', phases: ['baseline', 'opponent'], executionProfile: 'd02-original300-v12' })
    manifest.resources = { ...manifest.resources, timeoutMs: 86400000 }
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest))
    const descriptor = await importEvaluationDirectory(source, f.packages)
    for (const [samples, expected] of [[300, 86400000], [20, 3600000]]) {
      const i: ComposeEvaluationInput = {
        ...input(descriptor.id), role: 'defense', phase: 'baseline', timeoutMs: 86400000,
        parameters: { version: 'v3-261012-d02-original300-v12', maxModelCalls: 3600, number: '02', role: 'defense', samples },
        modelGateway: { url: 'http://host.docker.internal:4002/api/gateway', token: 'fixture' },
      }
      const base = mockExecutor(i, [])
      const result = await runComposeEvaluation(i, {
        packageRoot: f.packages, workspaceRoot: f.workspaces,
        executor: async (binary, args, options) => {
          if (args.includes('--no-deps')) {
            assert.ok(options.timeoutMs > expected - 5000 && options.timeoutMs <= expected)
            assert.equal(JSON.parse(fs.readFileSync(path.join(options.cwd, 'input/context.json'), 'utf8')).student.timeoutSeconds, expected / 1000)
          }
          return base(binary, args, options)
        },
      })
      assert.equal(result.status, 'completed')
      assert.equal(result.cleanupStatus, 'cleaned')
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})
test('cleanup failures leave a bounded recovery journal and recover only that project', async () => {
  const f = await fixture()
  try {
    const i = input(f.descriptor.id),
      commands: string[][] = []
    const result = await runComposeEvaluation(i, {
      executor: mockExecutor(i, commands, { downFail: true }),
      packageRoot: f.packages,
      workspaceRoot: f.workspaces,
    })
    assert.equal(result.cleanupStatus, 'cleanup_failed')
    const journals = fs.readdirSync(path.join(f.workspaces, '_cleanup'))
    assert.equal(journals.length, 1)
    const recovery: string[][] = []
    const recovered = await recoverPendingComposeCleanups({
      workspaceRoot: f.workspaces,
      executor: async (_binary, args) => {
        recovery.push(args)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    assert.deepEqual(recovered, { recovered: 1, pending: 0 })
    assert.ok(recovery[0].includes('down'))
    assert.ok(recovery[0].includes('--project-name'))
    assert.deepEqual(fs.readdirSync(path.join(f.workspaces, '_cleanup')), [])
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
test('parallel attempts get unique projects and material directories', async () => {
  const f = await fixture()
  try {
    const commands: string[][] = []
    const results = await Promise.all(
      [1, 2].map((n) => {
        const i = {
          ...input(f.descriptor.id),
          attemptId: `attempt-${n}`,
          code: `def solve(values): return ${n} * sum(values)`,
        }
        return runComposeEvaluation(i, {
          executor: mockExecutor(i, commands),
          packageRoot: f.packages,
          workspaceRoot: f.workspaces,
        })
      }),
    )
    assert.ok(results.every((r) => r.status === 'completed'))
    const projects = commands.filter((c) => c.includes('up')).map((c) => c[c.indexOf('--project-name') + 1])
    assert.equal(new Set(projects).size, 2)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
test('recovery skips active leases and atomically claims one expired project', async () => {
  const f = await fixture()
  try {
    const i = input(f.descriptor.id),
      commands: string[][] = []
    await runComposeEvaluation(i, {
      executor: mockExecutor(i, commands, { downFail: true }),
      packageRoot: f.packages,
      workspaceRoot: f.workspaces,
    })
    const directory = path.join(f.workspaces, '_cleanup'),
      file = path.join(directory, fs.readdirSync(directory)[0])
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'))
    journal.state = 'running'
    journal.expiresAt = Date.now() + 60000
    fs.writeFileSync(file, JSON.stringify(journal))
    let calls = 0
    const executor: CommandExecutor = async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    assert.deepEqual(await recoverPendingComposeCleanups({ workspaceRoot: f.workspaces, executor }), {
      recovered: 0,
      pending: 0,
    })
    assert.equal(calls, 0)
    assert.ok(fs.existsSync(file))
    journal.expiresAt = Date.now() - 1
    fs.writeFileSync(file, JSON.stringify(journal))
    const results = await Promise.all([
      recoverPendingComposeCleanups({ workspaceRoot: f.workspaces, executor }),
      recoverPendingComposeCleanups({ workspaceRoot: f.workspaces, executor }),
    ])
    assert.equal(calls, 1)
    assert.equal(
      results.reduce((n, r) => n + r.recovered, 0),
      1,
    )
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
test('baseline and opponent phases forward immutable parameters and exact opponent binding', async () => {
  const f = await fixture('attack-defense')
  try {
    for (const phase of ['baseline', 'opponent'] as const) {
      const i: ComposeEvaluationInput = {
        ...input(f.descriptor.id),
        phase,
        role: 'attack',
        parameters: { repetitions: 3, successThreshold: 0.5 },
        baseline: { fixture: 'baselines/defense.py' },
        opponent:
          phase === 'opponent'
            ? { submissionId: 'opponent-9', code: 'def defend(text): return text', filePath: null }
            : undefined,
      }
      const commands: string[][] = []
      const executor = mockExecutor(i, commands)
      const result = await runComposeEvaluation(i, {
        executor: async (binary, args, options) => {
          if (args.includes('up') && args.includes('--no-deps')) {
            const c = JSON.parse(fs.readFileSync(path.join(options.cwd, 'input/context.json'), 'utf8'))
            assert.equal(c.parameters.repetitions, 3)
            assert.equal(c.baseline.fixturePath, '/package/baselines/defense.py')
            if (phase === 'opponent')
              assert.equal(
                fs.readFileSync(path.join(options.cwd, 'opponent/materials/code.py'), 'utf8'),
                i.opponent!.code,
              )
          }
          return executor(binary, args, options)
        },
        packageRoot: f.packages,
        workspaceRoot: f.workspaces,
      })
      assert.equal(result.status, 'completed')
      if (phase === 'opponent') assert.equal(result.success, false)
      else assert.equal(result.metrics?.qualificationMetric, 0.5)
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
test('result contract rejects mismatched identifiers, invalid values and student-declared final opponent scores', () => {
  const i = input('package')
  for (const bad of [
    { attemptId: 'bad' },
    { submissionId: 'bad' },
    { questionVersion: 2 },
    { evaluationVersion: 'bad' },
    { phase: 'opponent' },
    { score: NaN },
    { score: -1 },
    { score: 101 },
    { maxScore: Infinity },
    { metrics: { x: Infinity } },
    { status: 'student_error', score: 0 },
  ])
    assert.throws(() => validateEvaluationResult(output(i, bad), i))
  const pair: ComposeEvaluationInput = {
    ...i,
    phase: 'opponent',
    opponent: { submissionId: 'o', code: 'x', filePath: null },
  }
  assert.throws(() => validateEvaluationResult(output(pair, { opponentSubmissionId: 'wrong' }), pair), /绑定/)
  assert.throws(() => validateEvaluationResult(output(pair, { score: 100 }), pair), /平台汇总/)
  assert.throws(() => validateEvaluationResult(output(pair, { success: 1 }), pair), /布尔/)
  assert.throws(() => validateEvaluationResult(output(pair, { metrics: {} }), pair), /成功指标/)
  assert.equal(validateEvaluationResult(output(pair), pair).success, false)
})
test('generated Compose grants no student host privileges and upstream secrets only reach relay', async () => {
  const m = validateManifest({
    schemaVersion: 1,
    protocol: 'platform-rpc-v1',
    name: 'test',
    image: 'python:3.12-slim',
    phases: ['basic'],
  })
  const offline = buildControlledCompose('/work/job', m, false) as any
  const s = offline.services.evaluator
  assert.deepEqual(s.networks, ['student-lane'])
  assert.equal(offline.networks['student-lane'].internal, true)
  assert.equal(s.user, '10001:10001')
  assert.equal(s.read_only, true)
  assert.deepEqual(s.cap_drop, ['ALL'])
  assert.ok(s.security_opt.includes('no-new-privileges:true'))
  assert.ok(s.volumes.every((v: any) => v.read_only && !v.source.includes('docker.sock')))
  assert.equal(s.ports, undefined)
  assert.equal(s.privileged, undefined)
  const online = buildControlledCompose('/work/job', { ...m, network: 'gateway' }, true) as any
  assert.deepEqual(online.services.evaluator.networks, ['student-lane', 'job-internal'])
  assert.equal(online.networks['job-internal'].internal, true)
  assert.ok(online.services.gateway.extra_hosts.includes('host.docker.internal:host-gateway'))
  assert.ok(!online.services.evaluator.volumes.some((v: any) => v.target === '/relay'))
  const pair = buildControlledCompose('/work/job', m, false, true) as any
  assert.deepEqual(pair.services.student.networks, ['student-lane'])
  assert.deepEqual(pair.services.opponent.networks, ['opponent-lane'])
  for (const name of ['student', 'opponent']) {
    const mounts = pair.services[name].volumes.map((v: any) => v.target)
    assert.deepEqual(mounts, ['/materials', '/worker'])
    assert.ok(
      pair.services[name].volumes.every((v: any) =>
        v.source.replace(/\\/g, '/').startsWith(`/work/job/${name}/`),
      ),
    )
  }
})
test('unsafe host material paths and nonfinite parameters never invoke Docker', async () => {
  const f = await fixture('model-inference')
  try {
    const i = {
      ...input(f.descriptor.id),
      filePath: path.join(EVALUATION_EXAMPLE_ROOT, 'model-inference/fixtures/weights.json'),
    }
    let calls = 0
    const executor: CommandExecutor = async () => {
      calls++
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const r = await runComposeEvaluation(i, {
      executor,
      packageRoot: f.packages,
      workspaceRoot: f.workspaces,
      materialRoots: [f.packages],
    })
    assert.equal(r.status, 'system_error')
    assert.equal(calls, 0)
    const invalid = await runComposeEvaluation(
      { ...i, parameters: { x: Infinity } },
      { executor, packageRoot: f.packages, workspaceRoot: f.workspaces },
    )
    assert.equal(invalid.status, 'system_error')
    assert.equal(calls, 0)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
test('RPC timeout follows the configured attempt deadline rather than a hidden 60-second cap', async () => {
  const f = await fixture()
  try {
    const source = path.join(f.root, 'long-package')
    fs.cpSync(path.join(EVALUATION_EXAMPLE_ROOT, 'basic-algorithm'), source, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
    manifest.resources.timeoutMs = 180000
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest))
    const descriptor = await importEvaluationDirectory(source, f.packages)
    const i = { ...input(descriptor.id), timeoutMs: 120000 },
      commands: string[][] = []
    const base = mockExecutor(i, commands)
    const result = await runComposeEvaluation(i, {
      packageRoot: f.packages,
      workspaceRoot: f.workspaces,
      executor: async (binary, args, options) => {
        if (args.includes('up') && args.includes('--no-deps')) {
          const context = JSON.parse(fs.readFileSync(path.join(options.cwd, 'input/context.json'), 'utf8'))
          assert.equal(context.student.timeoutSeconds, 120)
          assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 120000)
          assert.ok(context.student.deadline >= Date.now())
        }
        return base(binary, args, options)
      },
    })
    assert.equal(result.status, 'completed')
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
test('workers receive only explicitly public helpers and bootstrap, never hidden package files', async () => {
  const f = await fixture()
  try {
    const source = path.join(f.root, 'public-fixture')
    fs.cpSync(path.join(EVALUATION_EXAMPLE_ROOT, 'basic-algorithm'), source, { recursive: true })
    fs.mkdirSync(path.join(source, 'public'))
    fs.writeFileSync(
      path.join(source, 'public/bootstrap.py'),
      'def load_student(code_path, work_dir): pass\n',
    )
    fs.writeFileSync(path.join(source, 'public/helper.py'), 'PUBLIC_CONSTANT = 7\n')
    fs.writeFileSync(path.join(source, 'public/not-approved.py'), 'PRIVATE_CONSTANT = 9\n')
    fs.writeFileSync(path.join(source, 'hidden.py'), 'SECRET_ANSWER = 42\n')
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
    manifest.worker = {
      bootstrap: 'public/bootstrap.py',
      files: ['public/bootstrap.py', 'public/helper.py'],
    }
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest))
    const descriptor = await importEvaluationDirectory(source, f.packages)
    const i = {
      ...input(descriptor.id),
      opponent: { submissionId: 'opponent', code: 'pass', filePath: null },
    }
    const commands: string[][] = []
    const normal = mockExecutor(i, commands)
    let checked = false
    const executor: CommandExecutor = async (binary, args, options) => {
      if (args.includes('up') && args.includes('--detach')) {
        const workspace = options.cwd
        for (const name of ['student', 'opponent']) {
          const runtime = path.join(workspace, name, 'runtime')
          assert.deepEqual(fs.readdirSync(path.join(runtime, 'public')).sort(), ['bootstrap.py', 'helper.py'])
          assert.equal(fs.existsSync(path.join(runtime, 'hidden.py')), false)
          assert.equal(fs.existsSync(path.join(runtime, 'main.py')), false)
          const config = JSON.parse(fs.readFileSync(path.join(runtime, 'config.json'), 'utf8'))
          assert.equal(config.bootstrap, '/worker/public/bootstrap.py')
        }
        assert.equal(fs.existsSync(path.join(workspace, 'package/hidden.py')), true)
        checked = true
      }
      return normal(binary, args, options)
    }
    const result = await runComposeEvaluation(i, {
      packageRoot: f.packages,
      workspaceRoot: f.workspaces,
      executor,
    })
    assert.equal(result.status, 'completed')
    assert.equal(checked, true)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('real Python teaching entries invoke separate RPC processes for algorithm, parameter inference and both opponent outcomes', async (t) => {
  const python = process.env.EVALUATION_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const probe = spawnSync(python, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  if (probe.status !== 0) {
    t.skip('Python 3 unavailable; set EVALUATION_TEST_PYTHON for real RPC process verification')
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-python-'))
  try {
    const code = path.join(root, 'student.py'),
      contextFile = path.join(root, 'context.json'),
      resultFile = path.join(root, 'result.json')
    fs.writeFileSync(path.join(root, 'platform_student.py'), PLATFORM_STUDENT_CLIENT_SOURCE)
    const run = async (
      name: string,
      source: string,
      phase: 'basic' | 'baseline' | 'opponent',
      role?: 'attack' | 'defense',
      opponentCode?: string,
    ) => {
      fs.writeFileSync(code, source)
      const children: ReturnType<typeof spawn>[] = []
      const worker = async (label: string, workerCode: string) => {
        const cfg = path.join(root, `${label}-config.json`),
          sourceFile = path.join(root, `${label}-code.py`),
          server = path.join(root, `${label}-server.py`)
        fs.writeFileSync(
          cfg,
          JSON.stringify({ token: label, maxRequestBytes: 1048576, maxResponseBytes: 1048576 }),
        )
        fs.writeFileSync(sourceFile, workerCode)
        const serverSource = PLATFORM_STUDENT_WORKER_SOURCE.replace(
          "'/worker/config.json'",
          JSON.stringify(cfg),
        )
          .replaceAll("'/materials/code.py'", JSON.stringify(sourceFile))
          .replace(
            "http.server.ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()",
            "server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)\nprint(server.server_address[1], flush=True)\nserver.serve_forever()",
          )
        fs.writeFileSync(server, serverSource)
        const child = spawn(python, ['-B', server], {
          windowsHide: true,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
        })
        children.push(child)
        const port = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('RPC fixture startup timeout')), 5000)
          child.stdout.once('data', (d) => {
            clearTimeout(timer)
            resolve(Number(String(d).trim()))
          })
          child.once('error', (e) => {
            clearTimeout(timer)
            reject(e)
          })
          child.once('exit', () => {
            clearTimeout(timer)
            reject(new Error('RPC fixture exited before ready'))
          })
        })
        return {
          url: `http://127.0.0.1:${port}`,
          token: label,
          maxRequestBytes: 1048576,
          maxResponseBytes: 1048576,
          timeoutSeconds: 3,
        }
      }
      const context: any = {
        submissionId: 's',
        attemptId: 'a',
        questionVersion: 1,
        evaluationVersion: 'v1',
        phase,
        role,
        parameters: { repetitions: 2, successThreshold: 0.5 },
        student: await worker('student', source),
      }
      if (opponentCode) context.opponent = { submissionId: 'o', ...(await worker('opponent', opponentCode)) }
      fs.writeFileSync(contextFile, JSON.stringify(context))
      try {
        execFileSync(
          python,
          ['-B', path.join(EVALUATION_EXAMPLE_ROOT, name, 'main.py'), contextFile, resultFile],
          {
            timeout: 5000,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONPATH: root },
            windowsHide: true,
          },
        )
        return JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      } finally {
        for (const child of children) child.kill()
      }
    }
    assert.equal((await run('basic-algorithm', 'def solve(values): return sum(values)', 'basic')).score, 100)
    assert.equal((await run('basic-algorithm', 'def solve(values): return 0', 'basic')).score, 40)
    assert.equal(
      (
        await run(
          'basic-algorithm',
          'import builtins\nbuiltins.sum = lambda *a, **k: 0\ndef solve(values): return 0',
          'basic',
        )
      ).score,
      40,
      'student monkeypatch must not change trusted grader functions',
    )
    const weights = JSON.stringify(
      path.join(EVALUATION_EXAMPLE_ROOT, 'model-inference/fixtures/weights.json'),
    )
    assert.equal(
      (
        await run(
          'model-inference',
          `import json\np = json.load(open(${weights}))\ndef predict(x): return p['weight'] * x + p['bias']`,
          'basic',
        )
      ).score,
      100,
    )
    assert.equal(
      (await run('attack-defense', "def attack(): return 'SECRET'", 'baseline', 'attack')).metrics
        .qualificationMetric,
      1,
    )
    assert.equal(
      (
        await run(
          'attack-defense',
          "def attack(): return 'SECRET'",
          'opponent',
          'attack',
          'def defend(text): return text',
        )
      ).success,
      true,
    )
    assert.equal(
      (
        await run(
          'attack-defense',
          "def attack(): return 'SECRET'",
          'opponent',
          'attack',
          "def defend(text): return 'BLOCKED'",
        )
      ).success,
      false,
    )
    assert.equal(
      (await run('attack-defense', "def defend(text): return 'BLOCKED'", 'baseline', 'defense')).metrics
        .qualificationMetric,
      1,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test(
  'real Docker Compose integration (requires available daemon and preloaded approved image)',
  { skip: process.env.EVALUATION_DOCKER_TEST !== '1' && process.env.RUN_DOCKER_EVALUATION_TESTS !== '1' },
  async () => {
    const version = spawnSync(process.env.EVALUATION_DOCKER_BIN || 'docker', ['version'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    })
    assert.equal(version.status, 0, 'Docker daemon unavailable; cannot claim real isolation verification')
    const f = await fixture()
    try {
      const result = await runComposeEvaluation(input(f.descriptor.id), {
        packageRoot: f.packages,
        workspaceRoot: f.workspaces,
      })
      assert.equal(result.status, 'completed')
      assert.equal(result.score, 100)
      assert.equal(result.cleanupStatus, 'cleaned')
      const malicious = {
        ...input(f.descriptor.id),
        attemptId: 'host-boundary',
        code: "import os\ndef solve(values):\n    if any(os.path.exists(p) for p in ['/input/context.json', '/package/main.py', '/relay/context.json']): return -9999\n    return sum(values)",
      }
      const isolated = await runComposeEvaluation(malicious, {
        packageRoot: f.packages,
        workspaceRoot: f.workspaces,
      })
      assert.equal(isolated.status, 'completed')
      assert.equal(
        isolated.score,
        100,
        'student worker must not see grader inputs, hidden package or gateway credentials',
      )
      const model = await importEvaluationDirectory(
        path.join(EVALUATION_EXAMPLE_ROOT, 'model-inference'),
        f.packages,
      )
      const modelResult = await runComposeEvaluation(
        {
          ...input(model.id),
          attemptId: 'model-weights',
          code: "import json\np = json.load(open('/materials/weights.bin'))\ndef predict(x): return p['weight'] * x + p['bias']",
          filePath: path.join(EVALUATION_EXAMPLE_ROOT, 'model-inference/fixtures/weights.json'),
        },
        { packageRoot: f.packages, workspaceRoot: f.workspaces, materialRoots: [EVALUATION_EXAMPLE_ROOT] },
      )
      assert.equal(modelResult.status, 'completed')
      assert.equal(modelResult.score, 100)
      assert.equal(modelResult.cleanupStatus, 'cleaned')
      const pair = await importEvaluationDirectory(
        path.join(EVALUATION_EXAMPLE_ROOT, 'attack-defense'),
        f.packages,
      )
      const opposed = await runComposeEvaluation(
        {
          ...input(pair.id),
          attemptId: 'opponent-rpc',
          phase: 'opponent',
          role: 'attack',
          code: "def attack(): return 'SECRET'",
          opponent: {
            submissionId: 'real-opponent',
            code: "def defend(text): return 'BLOCKED'",
            filePath: null,
          },
          parameters: { successThreshold: 0.5 },
        },
        { packageRoot: f.packages, workspaceRoot: f.workspaces },
      )
      assert.equal(opposed.status, 'completed')
      assert.equal(opposed.success, false)
      assert.equal(opposed.cleanupStatus, 'cleaned')
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  },
)
