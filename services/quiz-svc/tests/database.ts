import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

// The disposable in-memory PostgreSQL engine never reads .env or connects to an existing database.
export async function createTestDatabase() {
  const db = await PGlite.create()
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  for (const entry of fs.readdirSync(path.join(root, 'prisma/migrations')).sort()) {
    const file = path.join(root, 'prisma/migrations', entry, 'migration.sql')
    if (fs.existsSync(file)) await db.exec(fs.readFileSync(file, 'utf8'))
  }
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
  // Prisma owns connection lifetime; the socket adapter must not close its pooled connection during a browser pause.
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 1, idleTimeout: 0 })
  await server.start()
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?connection_limit=1&pool_timeout=20`
  process.env.NODE_ENV = 'test'
  return {
    db,
    server,
    url: process.env.DATABASE_URL,
    async close() {
      await server.stop()
      await db.close()
    },
  }
}
