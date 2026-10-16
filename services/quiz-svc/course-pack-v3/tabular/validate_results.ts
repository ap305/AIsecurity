/** Validate actual RPC artifacts using exactly the production TypeScript parser. */
import fs from 'node:fs'
import path from 'node:path'
import { validateEvaluationResult } from '../../src/services/composeJudge.js'

const rows = process.argv.slice(2).map((directory) => {
  const context = JSON.parse(fs.readFileSync(path.join(directory, 'context.json'), 'utf8'))
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
  const checked = validateEvaluationResult(result, context)
  if (checked.status !== 'completed') throw new Error('reference did not complete: ' + path.basename(directory))
  return { artifact: path.basename(directory), status: checked.status, success: checked.success, metrics: checked.metrics }
})
console.log(JSON.stringify({ validator: 'composeJudge.validateEvaluationResult', count: rows.length, results: rows }, null, 2))
