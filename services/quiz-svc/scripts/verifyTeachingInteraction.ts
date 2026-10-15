/**
 * Read-only HTTP acceptance for the teaching UI contracts. No application/DB imports.
 * --api http://127.0.0.1:14003/api --token-file PRIVATE_TOKEN [--token-file PRIVATE_OTHER_TOKEN]
 * --output SANITIZED_REPORT.json
 * Supply existing student and admin tokens to exercise owner/foreign/admin boundaries.
 * Missing actors or submissions are reported as not-exercised; this script never creates them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { LEGACY_ACCEPTANCE_IDS } from './acceptanceLegacyCourses.js'

type Json = any
type Evidence = Record<string, number | boolean | string | null>
type Check = {
  name: string
  status: 'passed' | 'failed' | 'not-exercised'
  evidence?: Evidence
  reason?: string
}
type Actor = { token: string; userId: string; role: 'student' | 'admin'; label: string }
export interface TeachingVerificationOptions {
  api: string
  tokens: string[]
}
export interface TeachingVerificationReport {
  schemaVersion: number
  mode: 'read-only-http'
  target: string
  startedAt: string
  finishedAt: string
  status: 'passed' | 'partial' | 'failed'
  summary: { passed: number; failed: number; notExercised: number }
  limitations: string[]
  checks: Check[]
}
class VerificationError extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}
class NotExercised extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}
function expect(value: unknown, reason: string): asserts value {
  if (!value) throw new VerificationError(reason)
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function keys(value: unknown, allowed: string[]) {
  expect(record(value), 'diagnostics_object_expected')
  expect(
    Object.keys(value).every((key) => allowed.includes(key)),
    'diagnostics_contains_unapproved_fields',
  )
}

/** Validate the entire public diagnostic shape without copying any response into the report. */
export function assertSafeTeachingDiagnostics(value: unknown) {
  keys(value, [
    'questionVersion',
    'evaluationVersion',
    'historicalVersion',
    'phase',
    'state',
    'metrics',
    'baseline',
    'evaluation',
    'progress',
  ])
  const d = value as Json
  expect(
    count(d.questionVersion) && d.questionVersion > 0 && typeof d.evaluationVersion === 'string',
    'diagnostics_version_missing',
  )
  expect(
    typeof d.historicalVersion === 'boolean' && ['basic', 'baseline', 'opponents'].includes(d.phase),
    'diagnostics_phase_invalid',
  )
  expect(
    [
      'queued',
      'pending',
      'judging',
      'baseline',
      'opponents',
      'running',
      'completed',
      'passed',
      'failed',
      'baseline_failed',
      'error',
      'stale',
      'unavailable',
    ].includes(d.state),
    'diagnostics_state_invalid',
  )
  expect(
    record(d.metrics) &&
      Object.entries(d.metrics).every(
        ([key, item]) =>
          ['correct', 'total', 'testsPassed', 'testsTotal', 'accuracy', 'ratio'].includes(key) &&
          finite(item),
      ),
    'diagnostics_metrics_not_allowlisted',
  )
  if (d.baseline !== null) {
    keys(d.baseline, ['metric', 'value', 'threshold', 'comparator', 'passed'])
    expect(
      typeof d.baseline.metric === 'string' &&
        /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(d.baseline.metric) &&
        finite(d.baseline.threshold),
      'baseline_contract_invalid',
    )
    expect(d.baseline.comparator === '>=', 'baseline_comparator_not_inclusive')
    expect(
      d.baseline.value === null
        ? d.baseline.passed === null
        : finite(d.baseline.value) && d.baseline.passed === d.baseline.value >= d.baseline.threshold,
      'baseline_decision_inconsistent',
    )
  }
  if (d.evaluation !== null) {
    keys(d.evaluation, [
      'state',
      'snapshotRevision',
      'counted',
      'successCount',
      'opponentCount',
      'emptyPool',
      'pairs',
    ])
    expect(
      [
        'queued',
        'pending',
        'judging',
        'baseline',
        'opponents',
        'running',
        'completed',
        'passed',
        'failed',
        'baseline_failed',
        'error',
        'stale',
        'unavailable',
      ].includes(d.evaluation.state),
      'opponent_state_invalid',
    )
    expect(
      d.evaluation.snapshotRevision === null || count(d.evaluation.snapshotRevision),
      'snapshot_revision_invalid',
    )
    expect(
      typeof d.evaluation.counted === 'boolean' &&
        typeof d.evaluation.emptyPool === 'boolean' &&
        Array.isArray(d.evaluation.pairs),
      'opponent_summary_invalid',
    )
    const ordinals = new Set<number>()
    for (const pair of d.evaluation.pairs) {
      keys(pair, ['ordinal', 'state', 'success', 'metric', 'value', 'threshold'])
      expect(
        count(pair.ordinal) && pair.ordinal > 0 && !ordinals.has(pair.ordinal),
        'opponent_ordinal_invalid',
      )
      ordinals.add(pair.ordinal)
      expect(
        pair.state === 'completed' &&
          typeof pair.metric === 'string' &&
          /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(pair.metric),
        'opponent_evidence_invalid',
      )
      expect(
        finite(pair.value) && finite(pair.threshold) && pair.success === pair.value >= pair.threshold,
        'opponent_decision_inconsistent',
      )
    }
    if (d.evaluation.counted) {
      expect(
        d.evaluation.state === 'completed' && d.baseline?.passed === true,
        'counted_before_qualification',
      )
      expect(count(d.evaluation.successCount) && count(d.evaluation.opponentCount), 'counted_summary_missing')
      expect(
        d.evaluation.opponentCount === d.evaluation.pairs.length &&
          d.evaluation.successCount === d.evaluation.pairs.filter((pair: Json) => pair.success).length,
        'counted_denominator_inconsistent',
      )
      expect(d.evaluation.emptyPool === (d.evaluation.opponentCount === 0), 'empty_pool_flag_inconsistent')
    } else
      expect(
        d.evaluation.successCount === null &&
          d.evaluation.opponentCount === null &&
          d.evaluation.emptyPool === false,
        'partial_round_must_not_publish_counts',
      )
  }
  if (d.progress !== null) {
    keys(d.progress, ['state', 'completedOpponents', 'totalOpponents'])
    expect(
      ['queued', 'running', 'error'].includes(d.progress.state) && count(d.progress.completedOpponents),
      'progress_invalid',
    )
    expect(
      d.progress.totalOpponents === null ||
        (count(d.progress.totalOpponents) && d.progress.completedOpponents <= d.progress.totalOpponents),
      'progress_count_invalid',
    )
  }
}

export async function verifyTeachingInteraction(
  options: TeachingVerificationOptions,
): Promise<TeachingVerificationReport> {
  const url = new URL(options.api)
  expect(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /\/api\/?$/.test(url.pathname),
    'invalid_api_url',
  )
  const base = url.href.replace(/\/$/, '')
  const checks: Check[] = []
  const startedAt = new Date().toISOString()
  const actors: Actor[] = []
  const histories = new Map<string, Json[]>()
  let allQuestions: Json[] = []
  let studentCandidates: string[] = []
  const ownedSubmissions: { userId: string; id: string }[] = []
  async function check(name: string, action: () => Promise<Evidence | undefined>) {
    try {
      checks.push({ name, status: 'passed', evidence: await action() })
    } catch (error) {
      checks.push({
        name,
        status: error instanceof NotExercised ? 'not-exercised' : 'failed',
        reason:
          error instanceof VerificationError || error instanceof NotExercised
            ? error.reason
            : 'unexpected_response_or_transport_failure',
      })
    }
  }
  async function get(route: string, actor?: Actor, expectedStatus = 200) {
    expect(route.startsWith('/') && !route.startsWith('//'), 'invalid_internal_route')
    // Explicit GET and redirect rejection prevent this verifier from mutating data or forwarding tokens elsewhere.
    const response = await fetch(`${base}${route}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: actor ? { Authorization: `Bearer ${actor.token}` } : {},
    })
    expect(response.status === expectedStatus, 'unexpected_http_status')
    const json = (await response.json()) as Json
    expect(record(json), 'json_envelope_required')
    if (expectedStatus === 200) expect(json.code === 0, 'api_success_envelope_required')
    return json.data
  }
  for (const [index, token] of options.tokens.entries()) {
    await check(`actor-${index + 1}: authenticated identity`, async () => {
      const data = await get('/auth/me', { token, userId: '', role: 'student', label: '' })
      expect(
        record(data?.user) &&
          typeof data.user.id === 'string' &&
          ['student', 'admin'].includes(data.user.role),
        'authenticated_actor_missing',
      )
      expect(!actors.some((actor) => actor.userId === data.user.id), 'duplicate_actor_token')
      actors.push({ token, userId: data.user.id, role: data.user.role, label: `actor-${index + 1}` })
      return { role: data.user.role }
    })
  }
  const student = actors.find((actor) => actor.role === 'student')
  const admin = actors.find((actor) => actor.role === 'admin')
  const primary = student ?? admin
  await check('anonymous question access denied', async () => {
    await get('/questions', undefined, 401)
    return { status: 401 }
  })
  await check('twenty published course questions retain ten attack/defense pairs', async () => {
    if (!primary) throw new NotExercised('no_authenticated_actor')
    const data = await get('/questions', primary)
    expect(Array.isArray(data), 'question_list_required')
    allQuestions = data
    const known = data.filter((question: Json) => LEGACY_ACCEPTANCE_IDS.includes(question.id))
    expect(
      known.length === 20 && new Set(known.map((question: Json) => question.id)).size === 20,
      'published_course_slots_missing_or_duplicated',
    )
    const scenes = new Map<string, Set<string>>()
    for (const question of known) {
      expect(
        question.status === 'published' &&
          question.category === 'adversarial' &&
          typeof question.scenarioId === 'string' &&
          ['attack', 'defense'].includes(question.role),
        'published_role_contract_invalid',
      )
      const roles = scenes.get(question.scenarioId) ?? new Set<string>()
      expect(!roles.has(question.role), 'scenario_role_duplicated')
      roles.add(question.role)
      scenes.set(question.scenarioId, roles)
      expect(
        typeof question.attempted === 'boolean' && typeof question.hasHistoricalAttempts === 'boolean',
        'real_attempt_state_missing',
      )
      expect(
        question.latestSubmissionStatus === null || typeof question.latestSubmissionStatus === 'string',
        'latest_submission_status_missing',
      )
      expect(
        typeof question.myStatus === 'string' &&
          Array.isArray(question.tags) &&
          question.tags.every((tag: unknown) => typeof tag === 'string'),
        'question_status_or_tags_missing',
      )
      expect(question.myScore === null || finite(question.myScore), 'question_score_invalid')
      expect(
        question.solution === undefined && question.testConfig === undefined,
        'public_question_exposes_private_authoring_fields',
      )
      const evaluation = question.definition?.evaluation
      expect(
        record(evaluation) && finite(evaluation.baselineThreshold) && finite(evaluation.successThreshold),
        'published_thresholds_missing',
      )
      for (const key of [
        'packageId',
        'packageDigest',
        'baselineCode',
        'baselineFixture',
        'baselineWeightFixture',
        'parameters',
      ])
        expect(evaluation[key] === undefined, 'public_question_exposes_grader_configuration')
    }
    expect(
      scenes.size === 10 && [...scenes.values()].every((roles) => roles.size === 2),
      'ten_complete_scenario_pairs_required',
    )
    return { knownCourseQuestions: 20, pairedScenarios: 10, additionalPublishedQuestions: data.length - 20 }
  })
  const knownQuestions = allQuestions.filter((question) => LEGACY_ACCEPTANCE_IDS.includes(question.id))
  for (const question of knownQuestions) {
    await check(`${question.id}: public resources and current role score`, async () => {
      const files = await get(`/questions/${encodeURIComponent(question.id)}/resources`, primary)
      expect(
        Array.isArray(files) &&
          files.every(
            (file: Json) =>
              typeof file.filename === 'string' &&
              count(file.size) &&
              file.path === undefined &&
              file.filePath === undefined,
          ),
        'public_resource_metadata_invalid',
      )
      const score = await get(`/arena/questions/${encodeURIComponent(question.id)}/score`, primary)
      expect(
        score?.questionId === question.id &&
          score.questionVersion === question.revision &&
          score.role === question.role,
        'arena_score_bound_to_wrong_question',
      )
      expect(score.score === null || finite(score.score), 'arena_score_invalid')
      if (score.counted)
        expect(
          finite(score.score) &&
            score.qualified === true &&
            count(score.successCount) &&
            count(score.opponentCount) &&
            score.successCount <= score.opponentCount &&
            Math.abs(
              score.score - (score.opponentCount ? (100 * score.successCount) / score.opponentCount : 100),
            ) < 1e-8,
          'arena_score_formula_invalid',
        )
      if (score.updatedAt === question.dynamicScore?.updatedAt)
        expect(score.score === question.myScore, 'hall_score_differs_from_current_arena_score')
      return { resourceFiles: files.length, counted: Boolean(score.counted), score: score.score }
    })
  }
  for (const actor of actors.filter((item) => item.role === 'student')) {
    await check(`${actor.label}: own basic score and admin boundary`, async () => {
      const stats = await get(`/users/${encodeURIComponent(actor.userId)}/stats`, actor)
      expect(finite(stats?.totalScore) && count(stats?.tasksCompleted), 'own_basic_score_invalid')
      await get('/admin/student-scores', actor, 403)
      return {
        basicTotalScore: stats.totalScore,
        completedBasicQuestions: stats.tasksCompleted,
        adminStatus: 403,
      }
    })
    let totalHistory = 0,
      inspectedDiagnostics = 0
    await check(`${actor.label}: own histories and real attempt status`, async () => {
      const list = actor === primary ? allQuestions : await get('/questions', actor)
      expect(Array.isArray(list), 'question_list_required')
      for (const question of list) {
        const history = await get(`/questions/${encodeURIComponent(question.id)}/submissions`, actor)
        expect(Array.isArray(history), 'submission_history_required')
        histories.set(`${actor.userId}:${question.id}`, history)
        totalHistory += history.length
        expect(
          history.every(
            (submission: Json) => submission.userId === actor.userId && submission.questionId === question.id,
          ),
          'history_contains_foreign_submission',
        )
        const current = history.filter(
          (submission: Json) =>
            submission.questionVersion === question.revision &&
            (!submission.diagnostics ||
              submission.diagnostics.evaluationVersion === question.evaluationVersion),
        )
        // The history API is capped at 100; do not infer absence behind that cap.
        if (history.length < 100 || current.length > 0) {
          expect(question.attempted === current.length > 0, 'attempt_state_not_backed_by_history')
          expect(
            question.latestSubmissionStatus === (current[0]?.status ?? null),
            'latest_status_not_backed_by_history',
          )
        }
        for (const submission of history.slice(0, 5)) {
          ownedSubmissions.push({ userId: actor.userId, id: submission.id })
          const detail = await get(`/submissions/${encodeURIComponent(submission.id)}`, actor)
          expect(
            detail?.id === submission.id &&
              detail.userId === actor.userId &&
              detail.questionId === question.id,
            'submission_detail_identity_mismatch',
          )
          expect(
            detail.filePath === undefined && detail.configSnapshot === undefined,
            'submission_detail_exposes_private_configuration',
          )
          if (detail.diagnostics !== null) {
            assertSafeTeachingDiagnostics(detail.diagnostics)
            expect(
              detail.diagnostics.questionVersion === detail.questionVersion,
              'diagnostic_submission_version_mismatch',
            )
            expect(
              detail.diagnostics.historicalVersion ===
                (detail.questionVersion !== question.revision ||
                  detail.diagnostics.evaluationVersion !== question.evaluationVersion),
              'diagnostic_historical_flag_mismatch',
            )
            inspectedDiagnostics++
          }
        }
      }
      return { historyRows: totalHistory }
    })
    await check(`${actor.label}: real saved submission diagnostics`, async () => {
      if (!inspectedDiagnostics)
        throw new NotExercised(totalHistory ? 'no_saved_modern_diagnostics' : 'no_existing_submissions')
      return { inspectedSubmissions: inspectedDiagnostics }
    })
  }
  if (!student) {
    checks.push({
      name: 'student owner history and diagnostic boundaries',
      status: 'not-exercised',
      reason: 'student_token_not_supplied',
    })
  }
  await check('administrator student score list and details', async () => {
    if (!admin) throw new NotExercised('admin_token_not_supplied')
    const list = await get('/admin/student-scores?page=1&pageSize=100', admin)
    expect(Array.isArray(list?.students) && count(list.total), 'admin_student_score_list_invalid')
    studentCandidates = [
      ...new Set([
        ...actors.filter((actor) => actor.role === 'student').map((actor) => actor.userId),
        ...list.students
          .filter((item: Json) => item.submittedQuestionCount > 0)
          .slice(0, 5)
          .map((item: Json) => item.userId),
        ...list.students.slice(0, 1).map((item: Json) => item.userId),
      ]),
    ] as string[]
    if (!studentCandidates.length) throw new NotExercised('no_existing_students_for_admin_detail')
    let questionScores = 0
    for (const userId of studentCandidates) {
      const detail = await get(`/admin/student-scores/${encodeURIComponent(userId)}`, admin)
      expect(
        detail?.student?.userId === userId && Array.isArray(detail.questions),
        'admin_student_detail_invalid',
      )
      for (const question of detail.questions) {
        expect(question.score === null || finite(question.score), 'admin_question_score_invalid')
        expect(
          ['basic', 'adversarial'].includes(question.category) &&
            ['best', 'current'].includes(question.scoreKind),
          'admin_score_kind_invalid',
        )
        expect(
          question.code === undefined &&
            question.filePath === undefined &&
            question.result === undefined &&
            question.configSnapshot === undefined,
          'admin_score_page_exposes_materials',
        )
        if (question.latestSubmission?.id) ownedSubmissions.push({ userId, id: question.latestSubmission.id })
        const history = histories.get(`${userId}:${question.questionId}`)
        if (history && history.length < 100)
          expect(question.submissionCount >= history.length, 'admin_submission_count_inconsistent')
      }
      questionScores += detail.questions.length
    }
    return {
      totalStudents: list.total,
      inspectedStudents: studentCandidates.length,
      inspectedQuestionScores: questionScores,
    }
  })
  await check('foreign existing submissions are inaccessible to a student', async () => {
    if (!student) throw new NotExercised('student_token_not_supplied')
    const foreign = ownedSubmissions.find((submission) => submission.userId !== student.userId)
    if (!foreign) throw new NotExercised('no_existing_foreign_submission_available')
    await get(`/submissions/${encodeURIComponent(foreign.id)}`, student, 404)
    return { deniedExistingSubmissions: 1, status: 404 }
  })
  const summary = {
    passed: checks.filter((item) => item.status === 'passed').length,
    failed: checks.filter((item) => item.status === 'failed').length,
    notExercised: checks.filter((item) => item.status === 'not-exercised').length,
  }
  return {
    schemaVersion: 1,
    mode: 'read-only-http',
    target: base,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: summary.failed ? 'failed' : summary.notExercised ? 'partial' : 'passed',
    summary,
    limitations: [
      'GET requests only; no account, submission, publishing, or score mutations.',
      'At most five recent submissions per published question and the first 100 students are inspected.',
      'Missing real actors or saved diagnostic evidence remain not-exercised; this is not a new evaluation run.',
      'No browser rendering or screenshots; no identities, source code, raw API bodies or credentials are retained.',
    ],
    checks,
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      api: { type: 'string' },
      'token-file': { type: 'string', multiple: true },
      output: { type: 'string' },
    },
  })
  expect(values.api && values.output && values['token-file']?.length, 'required_options_missing')
  const output = path.resolve(values.output)
  const inputs = values['token-file'].map((file) => fs.realpathSync(file))
  expect(!fs.existsSync(output) || !fs.lstatSync(output).isSymbolicLink(), 'output_symlink_not_allowed')
  const resolvedOutput = fs.existsSync(output) ? fs.realpathSync(output) : output
  expect(
    !inputs.some((input) => input.toLowerCase() === resolvedOutput.toLowerCase()),
    'report_must_not_overwrite_token_file',
  )
  const tokens = inputs.map((file) => {
    expect(fs.statSync(file).size <= 16384, 'token_file_too_large')
    const token = fs.readFileSync(file, 'utf8').trim()
    expect(token.length >= 16 && !/\s/.test(token), 'token_file_invalid')
    return token
  })
  const report = await verifyTeachingInteraction({ api: values.api, tokens })
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, ...report.summary }))
  if (report.summary.failed) process.exitCode = 1
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        status: 'failed',
        reason: error instanceof VerificationError ? error.reason : 'verification_setup_failed',
      }),
    )
    process.exitCode = 1
  })
}
