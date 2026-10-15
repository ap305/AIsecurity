import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'

export async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: 'Serializable',
        maxWait: 10000,
        timeout: 20000,
      })
    } catch (error: any) {
      if (!['P2034', 'P2002'].includes(error?.code) || attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}
