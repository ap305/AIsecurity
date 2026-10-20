import crypto from 'node:crypto'

const reviewedBootstraps = new Set([
  '6fbd2196c9a59efdd544027434acc53cdc731d3ad4c74c1bcc8959d2dc943d48', // ML
  '827af9c9998daf78268f6b0a44c63b6f5cf764833ef2b5eaefeea582210ef557', // API / class roles
])

/** Compatibility for reviewed immutable packages; never transform student code. */
export function compatibleWorkerBootstrap(relative: string, bytes: Buffer): Buffer {
  if (relative !== 'public/bootstrap.py' || !reviewedBootstraps.has(
      crypto.createHash('sha256').update(bytes).digest('hex'))) return bytes
  // CPython's future-import validation also reads line numbers. Moving existing
  // AST nodes can leave the last future import at an earlier source line.
  // Reparse the assembled source inside the isolated worker, keeping the
  // immutable package, student input, model and grading policy unchanged.
  return Buffer.from(bytes.toString('utf8').replace(
    'compile(ast.fix_missing_locations(backend),',
    'compile(ast.unparse(ast.fix_missing_locations(backend)),',
  ))
}
