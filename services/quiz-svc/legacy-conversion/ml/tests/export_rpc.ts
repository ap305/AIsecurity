// Export the production protocol implementation for the Python process integration harness.
import fs from 'node:fs'
import path from 'node:path'
import { PLATFORM_STUDENT_CLIENT_SOURCE, PLATFORM_STUDENT_WORKER_SOURCE } from '../../../src/services/studentRpc.js'

const destination = process.argv[2]
if (!destination) throw new Error('expected a destination directory')
fs.mkdirSync(destination, { recursive: true })
fs.writeFileSync(path.join(destination, 'platform_student.py'), PLATFORM_STUDENT_CLIENT_SOURCE)
fs.writeFileSync(path.join(destination, 'worker-template.py'), PLATFORM_STUDENT_WORKER_SOURCE)
