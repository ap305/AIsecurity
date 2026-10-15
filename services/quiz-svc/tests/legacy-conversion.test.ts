import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calibratedLegacyDefinition,
  assertLegacySuccessPolicy,
  validateLegacyAcceptance,
  legacyCalibrationDiagnostic,
  legacyOpponentThresholdDiagnostic,
  assertLegacyCalibrationEvidence,
  BOT_ZERO_REFERENCE_POLICY,
  assertLegacyVerification,
  validateLegacyRecords,
  validateLegacyMetrics,
  legacyQuestionUpdate,
  matchesPublishedLegacyConversion,
  legacyRecordsMatchForRefresh,
  legacyFrozenPoolMatchesForRefresh,
  type LegacyConversionRecord,
} from '../src/lib/legacyConversion.js'

function record(): LegacyConversionRecord {
  return {
    questionId: 'MNIST-POISON',
    scenarioId: 'mnist_poison',
    role: 'attack',
    title: 'title',
    content: 'content',
    answerTemplate: 'def attack(): pass',
    solution: 'def attack(): pass',
    packageDirectory: '/packages/poison',
    referenceCodePath: '/packages/poison/baselines/attack.py',
    calibrationRequired: true,
    provenance: { sourceVersion: 'v2' },
    calibration: { baseline: 'fixed', baselineThreshold: 0.05, opponent: 'reference' },
    definition: {
      kind: 'algorithm',
      weights: {},
      teacherApi: {},
      llm: { enabled: false },
      evaluation: {
        baselineMetric: 'qualificationMetric',
        successMetric: 'successMetric',
        calibrationMode: true,
      },
    },
  }
}
test('conversion scope rejects unexpected or duplicate questions and unknown threshold policies', () => {
  const row = record()
  assert.equal(validateLegacyRecords([row]).length, 1)
  assert.throws(() => validateLegacyRecords([row, row]), /重复/)
  assert.throws(() => validateLegacyRecords([{ ...row, questionId: 'not-authorized' }]), /未授权/)
  assert.throws(
    () => validateLegacyRecords([{ ...row, calibration: { baseline: 'fixed', opponent: 'reference' } }]),
    /固定门槛/,
  )
  assert.throws(() => validateLegacyRecords([{ ...row, calibration: undefined }]), /校准政策/)
  assert.throws(() => validateLegacyRecords([{ ...row, scenarioId: 'watermark_image' }]), /场景/)
  assert.throws(() => validateLegacyRecords([{ ...row, role: 'defense' }]), /角色/)
  assert.throws(() => validateLegacyRecords([{ ...row, definition: {} }]), /指标/)
})

test('refresh ignores only local paths, preserving every course, policy and reference-content field', () => {
  const previous = record()
  assert.equal(
    legacyRecordsMatchForRefresh(previous, {
      ...previous,
      packageDirectory: '/new/output/package',
      referenceCodePath: '/new/output/reference.py',
    }),
    true,
  )
  for (const alter of [
    (row: LegacyConversionRecord) => {
      row.content = 'changed course description'
    },
    (row: LegacyConversionRecord) => {
      row.solution = 'changed official reference'
    },
    (row: LegacyConversionRecord) => {
      row.calibration.baselineThreshold = 0.01
    },
    (row: LegacyConversionRecord) => {
      row.definition.evaluation.seed = 100
    },
    (row: LegacyConversionRecord) => {
      row.provenance.sourceDigest = 'different files'
    },
    (row: LegacyConversionRecord) => {
      row.poolSpec = { id: 'new', kind: 'llm', name: 'changed', parameters: {} }
    },
  ]) {
    const current = structuredClone(previous)
    alter(current)
    assert.equal(legacyRecordsMatchForRefresh(previous, current), false)
  }
})

test('refresh reuses model evidence only for the exact frozen pool revision and inference parameters', () => {
  const desired = {
    name: 'course pool',
    kind: 'llm',
    model: 'qwen3-8b',
    modelVersion: 'fixed-v1',
    baseUrl: 'http://model.invalid/v1',
    credentialEnv: 'MODEL_SECRET',
    enabled: true,
    parameters: { temperature: 0, seed: 42, tools: [{ type: 'function' }] },
  }
  const pool = { ...desired, id: 'pool', revision: 4 }
  const frozen = { poolId: 'pool', poolRevision: 4 }
  assert.equal(legacyFrozenPoolMatchesForRefresh(pool, frozen, desired), true)
  for (const changed of [
    undefined,
    { ...pool, id: 'another' },
    { ...pool, revision: 5 },
    { ...pool, modelVersion: 'fixed-v2' },
    { ...pool, enabled: false },
    { ...pool, parameters: { ...desired.parameters, temperature: 0.1 } },
    { ...pool, credentialEnv: 'OTHER_SECRET' },
  ])
    assert.equal(legacyFrozenPoolMatchesForRefresh(changed, frozen, desired), false)
})

test('verification rejects missing, string and non-finite metrics rather than treating them as qualification', () => {
  for (const metrics of [undefined, {}, { qualificationMetric: '0.9' }, { qualificationMetric: Infinity }])
    assert.throws(() => validateLegacyMetrics(metrics, 'qualificationMetric'), /缺少/)
  assert.equal(validateLegacyMetrics({ qualificationMetric: 0 }, 'qualificationMetric'), 0)
})

test('publication text replaces pending calibration notice and freezes the measured inclusive thresholds', () => {
  const row = record()
  row.content += '\n\n本题处于迁移校准阶段，未完成官方参考实测门槛前不得发布。'
  const definition = calibratedLegacyDefinition(row, 'p', {
    baseline: { qualificationMetric: 0.05 },
    opponent: { successMetric: 0.037 },
  })
  const update = legacyQuestionUpdate(row, definition)
  assert.doesNotMatch(update.content, /不得发布|迁移校准阶段/)
  assert.match(update.content, /qualificationMetric` ≥ 0\.05/)
  assert.match(update.content, /successMetric` ≥ 0\.037/)
})

test('interrupted publication resumes only for the exact intended published version and package digest', () => {
  const row = record()
  const definition = calibratedLegacyDefinition(row, 'p', {
    baseline: { qualificationMetric: 0.05 },
    opponent: { successMetric: 0.037 },
  })
  const update = legacyQuestionUpdate(row, definition)
  const before = { revision: 1 }
  const current = { ...update, revision: 2, definition: structuredClone(definition) }
  current.definition.evaluation.packageDigest = 'digest'
  assert.equal(matchesPublishedLegacyConversion(current, before, update, 'digest'), true)
  for (const altered of [
    { ...current, revision: 1 },
    { ...current, revision: 3 },
    { ...current, status: 'draft' },
    { ...current, content: 'edited by another teacher' },
    { ...current, role: 'defense' },
  ])
    assert.equal(matchesPublishedLegacyConversion(altered, before, update, 'digest'), false)
  assert.equal(matchesPublishedLegacyConversion(current, before, update, 'different-digest'), false)
  assert.equal('packageDigest' in definition.evaluation, false)
})
test('real calibration preserves fixed boundaries, includes equality, and never substitutes a missing metric', () => {
  const row = record()
  const metrics = { baseline: { qualificationMetric: 0.05 }, opponent: { successMetric: 0.037 } }
  const result = calibratedLegacyDefinition(row, 'real-package', metrics)
  assert.equal(result.evaluation.baselineThreshold, 0.05)
  assert.equal(result.evaluation.successThreshold, 0.037)
  assert.equal(result.evaluation.packageId, 'real-package')
  assert.equal('calibrationMode' in result.evaluation, false)
  const below = { ...metrics, baseline: { qualificationMetric: 0.049 } }
  const candidate = calibratedLegacyDefinition(row, 'real-package', below)
  assert.equal(candidate.evaluation.baselineThreshold, 0.05)
  assert.deepEqual(legacyCalibrationDiagnostic(row, candidate, below.baseline), {
    policy: 'fixed',
    metric: 'qualificationMetric',
    observed: 0.049,
    threshold: 0.05,
    qualified: false,
    status: 'requires_acceptance',
    readyToPublish: false,
  })
  assert.throws(() => calibratedLegacyDefinition(row, 'real-package', { ...metrics, opponent: {} }), /缺少/)
  assert.throws(
    () => calibratedLegacyDefinition(row, 'real-package', { ...metrics, opponent: { successMetric: NaN } }),
    /缺少/,
  )
})

test('acceptance material maps only authorized question IDs to code paths and cannot alter configuration', () => {
  const row = record()
  assert.deepEqual(validateLegacyAcceptance({ 'MNIST-POISON': './acceptance.py' }, [row]), {
    'MNIST-POISON': './acceptance.py',
  })
  for (const input of [
    null,
    [],
    { unknown: 'code.py' },
    { 'PATCH-AD': 'code.py' },
    { 'MNIST-POISON': { codePath: 'code.py', baselineThreshold: 0 } },
    { 'MNIST-POISON': '' },
    { 'MNIST-POISON': 'code.py\0' },
    { baselineThreshold: 0 },
  ])
    assert.throws(() => validateLegacyAcceptance(input, [row]), /验收材料/)
})

test('reference thresholds stay measured while exact verification must pass the unchanged fixed baseline', () => {
  const row = record()
  const metrics = { baseline: { qualificationMetric: 0.01 }, opponent: { successMetric: 0.4 } }
  const fixed = calibratedLegacyDefinition(row, 'p', metrics)
  row.calibration.baseline = 'reference'
  const reference = calibratedLegacyDefinition(row, 'p', metrics)
  assert.equal(reference.evaluation.baselineThreshold, 0.01)
  assert.equal(legacyCalibrationDiagnostic(row, reference, metrics.baseline).status, 'reference_qualified')
  const configurations = { baseline: 'baseline-config', opponent: 'opponent-config' }
  const proof: any = Object.fromEntries(
    ['baseline', 'opponent'].map((phase) => [
      phase,
      {
        configuration: configurations[phase as keyof typeof configurations],
        codeDigest: 'actual-code-sha',
        record: {
          status: 'completed',
          result: {
            status: 'completed',
            cleanupStatus: 'cleaned',
            metrics: { qualificationMetric: 0.05, successMetric: 0 },
          },
        },
      },
    ]),
  )
  assert.doesNotThrow(() => assertLegacyVerification(fixed, proof, configurations, 'actual-code-sha'))
  // Normal opponent failure is valid; only baseline qualification is required for publication.
  for (const mutate of [
    (p: any) => {
      p.baseline.record.result.metrics.qualificationMetric = 0.049
    },
    (p: any) => {
      p.baseline.record.status = 'running'
    },
    (p: any) => {
      p.opponent.record.result.status = 'system_error'
    },
    (p: any) => {
      p.opponent.record.result.cleanupStatus = 'failed'
    },
    (p: any) => {
      p.baseline.codeDigest = 'different-code'
    },
    (p: any) => {
      p.opponent.configuration = 'different-definition'
    },
    (p: any) => {
      delete p.opponent.record.result.metrics.successMetric
    },
    (p: any) => {
      delete p.baseline
    },
  ]) {
    const changed = structuredClone(proof)
    mutate(changed)
    assert.throws(() => assertLegacyVerification(fixed, changed, configurations, 'actual-code-sha'))
  }
})
test('Bot false-positive gate and frozen model binding are required even during calibration', () => {
  const row = record()
  row.scenarioId = 'webbot'
  row.calibration.baseline = 'reference'
  row.definition.evaluation.samples = 4
  row.provenance.samples = 4
  row.definition.kind = 'agent'
  row.definition.llm.enabled = true
  assert.throws(
    () =>
      calibratedLegacyDefinition(
        row,
        'p',
        { baseline: { qualificationMetric: -1, samples: 4 }, opponent: { successMetric: 1, samples: 4 } },
        'pool',
      ),
    /误伤/,
  )
  const metrics = {
    baseline: { qualificationMetric: 0, samples: 4 },
    opponent: { successMetric: 0.25, samples: 4 },
  }
  assert.throws(() => calibratedLegacyDefinition(row, 'p', metrics), /模型池/)
  assert.equal(calibratedLegacyDefinition(row, 'p', metrics, 'frozen-pool').llm.poolId, 'frozen-pool')
})

test('only exactly-zero Bot reference rates use the approved one-win threshold and preserve raw evidence', () => {
  for (const [scenarioId, samples] of [
    ['chatops', 20],
    ['agendabot', 4],
    ['supportbot', 3],
    ['webbot', 4],
  ] as const) {
    const row = record()
    row.scenarioId = scenarioId
    row.calibration.baseline = 'reference'
    row.definition.evaluation.samples = samples
    row.provenance.samples = samples
    const measurements = {
      baseline: { qualificationMetric: 0, samples },
      opponent: { successMetric: 0, samples },
    }
    const definition = calibratedLegacyDefinition(row, 'p', measurements)
    assert.equal(definition.evaluation.successThreshold, 1 / samples)
    assert.equal(definition.evaluation.baselineThreshold, 0)
    assert.equal(measurements.opponent.successMetric, 0)
    const decision = legacyOpponentThresholdDiagnostic(row, measurements.opponent)
    assert.equal(decision.policy, BOT_ZERO_REFERENCE_POLICY)
    assert.equal(decision.samples, samples)
    assert.equal(decision.observed, 0)
    assert.equal(decision.threshold, 1 / samples)
    const evidence = {
      ...measurements,
      provenance: row.provenance,
      policy: row.calibration,
      opponentThreshold: decision,
    }
    assert.doesNotThrow(() =>
      assertLegacyCalibrationEvidence(row, definition, measurements, evidence, { packageId: 'p' }),
    )
    assert.throws(
      () =>
        assertLegacyCalibrationEvidence(
          row,
          definition,
          measurements,
          {
            ...evidence,
            opponentThreshold: undefined,
          },
          { packageId: 'p' },
        ),
      /决议证据/,
    )
    const tampered = structuredClone(definition)
    tampered.evaluation.successThreshold = 0.5 / samples
    assert.throws(
      () => assertLegacyCalibrationEvidence(row, tampered, measurements, evidence, { packageId: 'p' }),
      /冻结门槛/,
    )
    const publication = legacyQuestionUpdate(row, definition)
    assert.match(publication.content, new RegExp(`1/${samples}`))
    assert.match(publication.content, /至少成功 1 个样本/)
    for (const successMetric of [1e-12, 0.05, 1]) {
      const nonzero = calibratedLegacyDefinition(row, 'p', {
        ...measurements,
        opponent: { successMetric, samples },
      })
      assert.equal(nonzero.evaluation.successThreshold, successMetric)
    }
    for (const successMetric of [-0.1, 1.1])
      assert.throws(
        () => calibratedLegacyDefinition(row, 'p', { ...measurements, opponent: { successMetric, samples } }),
        /胜率/,
      )
    assert.doesNotThrow(() => legacyQuestionUpdate(row, definition))
    definition.evaluation.successThreshold = 0
    assert.throws(() => assertLegacySuccessPolicy(row, definition), /正常失败/)
    assert.throws(() => legacyQuestionUpdate(row, definition), /正常失败/)
    row.calibration.opponent = 'fixed'
    row.calibration.successThreshold = 0
    assert.throws(
      () =>
        calibratedLegacyDefinition(row, 'p', {
          baseline: { qualificationMetric: 0, samples },
          opponent: { successMetric: 1, samples },
        }),
      /正常失败/,
    )
  }
})

test('Bot sample counts must match frozen parameters, provenance and both actual measurements', () => {
  const row = record()
  row.scenarioId = 'chatops'
  row.definition.evaluation.samples = 20
  row.provenance.samples = 20
  const metrics = {
    baseline: { qualificationMetric: 0, samples: 20 },
    opponent: { successMetric: 0, samples: 20 },
  }
  for (const invalid of [undefined, 0, -1, 1.5, true, '20', 101]) {
    const changed = structuredClone(row)
    changed.definition.evaluation.samples = invalid
    assert.throws(() => calibratedLegacyDefinition(changed, 'p', metrics), /样本数/)
  }
  assert.throws(
    () => calibratedLegacyDefinition({ ...row, provenance: { samples: 3 } }, 'p', metrics),
    /样本数/,
  )
  assert.throws(
    () => calibratedLegacyDefinition(row, 'p', { ...metrics, opponent: { successMetric: 0, samples: 3 } }),
    /样本数/,
  )
  assert.throws(
    () =>
      calibratedLegacyDefinition(row, 'p', { ...metrics, baseline: { qualificationMetric: 0, samples: 3 } }),
    /样本数/,
  )
  row.definition.evaluation.parameters = { samples: 3 }
  assert.throws(() => calibratedLegacyDefinition(row, 'p', metrics), /样本数/)
})

test('calibration gates bind the complete definition and independent package/model identities', () => {
  const row = record()
  row.scenarioId = 'webbot'
  row.definition.kind = 'agent'
  row.definition.llm = { enabled: true }
  row.definition.evaluation.samples = 4
  row.definition.evaluation.parameters = { seed: 42 }
  row.provenance.samples = 4
  const metrics = {
    baseline: { qualificationMetric: 0.6, samples: 4 },
    opponent: { successMetric: 0.25, samples: 4 },
  }
  const definition = calibratedLegacyDefinition(row, 'immutable-package', metrics, 'frozen-pool')
  const evidence = {
    ...metrics,
    provenance: row.provenance,
    policy: row.calibration,
    opponentThreshold: legacyOpponentThresholdDiagnostic(row, metrics.opponent),
  }
  const binding = { packageId: 'immutable-package', poolId: 'frozen-pool' }
  assert.doesNotThrow(() => assertLegacyCalibrationEvidence(row, definition, metrics, evidence, binding))
  for (const change of [
    (candidate: typeof definition) => {
      candidate.evaluation.baselineMetric = 'successMetric'
    },
    (candidate: typeof definition) => {
      candidate.evaluation.successMetric = 'qualificationMetric'
    },
    (candidate: typeof definition) => {
      candidate.evaluation.timeoutMs += 1
    },
    (candidate: typeof definition) => {
      candidate.evaluation.repetitions += 1
    },
    (candidate: typeof definition) => {
      candidate.evaluation.parameters = { seed: 43 }
    },
    (candidate: typeof definition) => {
      candidate.llm.enabled = false
    },
  ]) {
    const changed = structuredClone(definition)
    change(changed)
    assert.throws(
      () => assertLegacyCalibrationEvidence(row, changed, metrics, evidence, binding),
      /完整评测定义/,
    )
  }
  for (const changed of [
    { ...definition, evaluation: { ...definition.evaluation, packageId: 'another-package' } },
    { ...definition, llm: { ...definition.llm, poolId: 'another-model' } },
  ])
    assert.throws(() => assertLegacyCalibrationEvidence(row, changed, metrics, evidence, binding), /绑定/)
  assert.throws(
    () => assertLegacyCalibrationEvidence(row, definition, metrics, evidence, { packageId: '' }),
    /绑定/,
  )
})

test('legitimate ML zero or negative margin thresholds remain unchanged by the Bot safeguard', () => {
  for (const opponent of ['fixed', 'reference'] as const) {
    for (const threshold of [0, -0.05]) {
      const row = record()
      row.calibration.opponent = opponent
      row.calibration.successThreshold = threshold
      const definition = calibratedLegacyDefinition(row, 'p', {
        baseline: { qualificationMetric: 0.05 },
        opponent: { successMetric: threshold },
      })
      assert.equal(definition.evaluation.successThreshold, threshold)
      assert.doesNotThrow(() => legacyQuestionUpdate(row, definition))
    }
  }
})
