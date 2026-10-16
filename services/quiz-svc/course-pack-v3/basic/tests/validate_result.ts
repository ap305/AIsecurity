import fs from 'node:fs'
import { validateEvaluationResult } from '../../../src/services/composeJudge.js'

const [contextPath, resultPath] = process.argv.slice(2)
const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'))
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
validateEvaluationResult(result, context)
process.stdout.write(JSON.stringify({ protocol: 'passed', phase: context.phase, status: result.status }) + '\n')
