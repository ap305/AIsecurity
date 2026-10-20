/** Read-only certificate for the user's explicitly prioritized B01-B17 release.
 * Attack/defense rows and whole-pack readiness remain unchanged and unready.
 * The importer must still execute all 17 final-configuration Docker self-tests.
 */
import fs from 'node:fs'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {pathToFileURL} from 'node:url'
import AdmZip from 'adm-zip'
import {loadCoursePack, sha256, COURSE_PACK_IDS} from './importCoursePackV3.js'
import {normalizeDefinition} from '../src/lib/prdContract.js'
import {selfTestConfigurationKey} from '../src/lib/selfTestContract.js'
import {decodeEvaluationArchive} from '../src/lib/evaluationPackage.js'

const requireThat = (ok: unknown, reason: string) => { if (!ok) throw new Error(reason) }
const parameters = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
export async function certifyBasics(o: {manifest: string; evidence: string; state: string; output: string; api: string; tokenFile: string}, fetchImpl: typeof fetch = fetch) {
  requireThat(['http://127.0.0.1:14004/api', 'http://127.0.0.1:14004/api'].includes(o.api), 'production_api_required')
  const {manifest, root, manifestDigest} = loadCoursePack(path.resolve(o.manifest))
  const output = path.resolve(o.output)
  requireThat(path.dirname(output) === root && !fs.existsSync(output) && !fs.existsSync(output + '.proof.json'), 'fresh_sibling_output_required')
  for (const name of [o.state, o.evidence, o.tokenFile]) requireThat(fs.lstatSync(name).isFile() && !fs.lstatSync(name).isSymbolicLink(), 'regular_input_required')
  const stateBytes = fs.readFileSync(o.state), evidenceBytes = fs.readFileSync(o.evidence)
  const state = JSON.parse(stateBytes.toString('utf8')), evidence = JSON.parse(evidenceBytes.toString('utf8'))
  requireThat(state.manifestDigest === manifestDigest && state.evidenceDigest === sha256(evidenceBytes) && state.api === o.api, 'source_state_binding_mismatch')
  requireThat(!state.references && !state.refreshFrom, 'original_calibration_source_required')
  requireThat(/@sha256:[a-f0-9]{64}$/.test(evidence.image), 'immutable_image_required')
  requireThat(manifest.requiresCalibration === true && manifest.deploymentReady === false &&
    manifest.questions.every(q => q.deploymentReady === false && (q.category === 'basic' || q.requiresCalibration === true)), 'original_unready_manifest_required')
  const token = fs.readFileSync(o.tokenFile, 'utf8').trim()
  requireThat(token.length >= 16, 'token_invalid')
  async function read(route: string) {
    const r = await fetchImpl(o.api + route, {headers: {Authorization: 'Bearer ' + token, Connection: 'close'}, redirect: 'error', signal: AbortSignal.timeout(120000)})
    requireThat(r.ok, 'certificate_http_failed')
    const e = await r.json() as any
    requireThat(e.code === 0, 'certificate_api_failed')
    return e.data
  }
  requireThat((await read('/auth/me'))?.user?.role === 'admin', 'administrator_required')
  const final = structuredClone(manifest), rows = final.questions.filter(q => q.category === 'basic')
  requireThat(rows.length === 17 && COURSE_PACK_IDS.filter(id => id.includes('-B')).every(id => rows.some(q => q.id === id)), 'exact_17_basics_required')
  const proofs: any[] = [], packageDigests = new Map<string, string>()
  for (const q of rows) {
    requireThat(!q.definition.llm.enabled && !q.role, 'basic_only_required')
    const pkg = manifest.packages.find(p => p.key === q.packageKey)!, installed = state.packages[q.packageKey]
    requireThat(installed && installed.inputDigest === sha256(JSON.stringify(pkg.files)), 'package_input_binding_mismatch')
    if (!packageDigests.has(pkg.key)) {
      const zip = new AdmZip()
      for (const file of [...pkg.files].sort((a,b) => a.path.localeCompare(b.path))) zip.addFile(file.path, fs.readFileSync(path.join(root, pkg.directory, file.path)))
      packageDigests.set(pkg.key, sha256(JSON.stringify(Object.fromEntries([...decodeEvaluationArchive(zip.toBuffer())].map(([name,bytes]) => [name,sha256(bytes)])))))
      requireThat(JSON.parse(fs.readFileSync(path.join(root,pkg.directory,'manifest.json'),'utf8')).image === evidence.image, 'source_image_mismatch')
    }
    requireThat(packageDigests.get(pkg.key) === installed.digest, 'installed_package_binding_mismatch')
    const proof = state.tests[q.id]?.basic
    requireThat(proof?.id && proof?.record, 'basic_calibration_proof_missing')
    const definition = structuredClone(q.definition)
    definition.evaluation = {...definition.evaluation, packageId: installed.id, calibrationMode: true, baselineThreshold: 0, successThreshold: 1}
    const weight = q.selfTest.weightFixture ? pkg.files.find(f => f.path === q.selfTest.weightFixture)!.sha256 : null
    const binding = sha256(JSON.stringify({manifestDigest, questionId:q.id, phase:'basic', code:q.selfTest.codeSha256, weights:weight, opponentCode:null, opponentWeights:null}))
    definition.evaluation.parameters = {...parameters(definition.evaluation.parameters), calibrationReferenceBinding: binding}
    const key = selfTestConfigurationKey(normalizeDefinition(definition), null, 'basic')
    requireThat(proof.configurationKey === key && proof.record.configurationKey === key, 'basic_configuration_changed')
    const live = await read(`/admin/evaluation-packages/${installed.id}/self-tests/${proof.id}`)
    requireThat(live.id === proof.id && live.packageId === installed.id && live.packageDigest === installed.digest && live.phase === 'basic' && live.configurationKey === key, 'live_proof_binding_changed')
    requireThat(live.status === 'completed' && live.result?.status === 'completed' && live.result.cleanupStatus === 'cleaned', 'basic_proof_not_completed_and_clean')
    const score = live.result.score
    requireThat(Number.isFinite(score) && score > 0 && score <= q.definition.evaluation.maxScore && live.result.maxScore === q.definition.evaluation.maxScore && score >= (q.selfTest.minimumScore ?? 0) && score === proof.record.result?.score, 'basic_measured_score_invalid')
    delete q.definition.evaluation.calibrationMode
    const finalParameters = parameters(q.definition.evaluation.parameters)
    delete finalParameters.calibrationMode
    delete finalParameters.calibrationReferenceBinding
    q.requiresCalibration = false; q.deploymentReady = true
    proofs.push({questionId:q.id, id:proof.id, packageDigest:installed.digest, configurationKey:key, score, cleanupStatus:'cleaned'})
  }
  requireThat(fs.readFileSync(o.state).equals(stateBytes) && fs.readFileSync(o.evidence).equals(evidenceBytes) && loadCoursePack(path.resolve(o.manifest)).manifestDigest === manifestDigest, 'certificate_inputs_changed')
  requireThat(final.questions.filter(q => q.category !== 'basic').every(q => q.requiresCalibration && !q.deploymentReady), 'adversarial_readiness_must_remain_false')
  fs.writeFileSync(output, JSON.stringify(final,null,2), {flag:'wx',mode:0o600})
  const report = {kind:'basic17-only-checkpoint', wholePackReady:false, sourceManifestDigest:manifestDigest, sourceStateSha256:sha256(stateBytes), outputSha256:sha256(fs.readFileSync(output)), apiWrites:0, basicProofs:proofs, adversarialQuestionsStillUnready:60}
  fs.writeFileSync(output+'.proof.json', JSON.stringify(report,null,2), {flag:'wx',mode:0o600})
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {values:v} = parseArgs({options:{manifest:{type:'string'},evidence:{type:'string'},state:{type:'string'},output:{type:'string'},api:{type:'string'},'token-file':{type:'string'}}})
  certifyBasics({manifest:v.manifest!,evidence:v.evidence!,state:v.state!,output:v.output!,api:v.api!,tokenFile:v['token-file']!}).then(r => console.log(JSON.stringify(r))).catch(e => {console.error(e.message);process.exitCode=1})
}
