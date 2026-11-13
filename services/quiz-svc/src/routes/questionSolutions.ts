import { Router } from 'express'
import { authPayload, requireUser, type TokenPayload } from '../lib/auth.js'
import { AuthError } from '../lib/authPassword.js'
import { RequestError } from '../lib/prdContract.js'
import {
  createQuestionSolution,
  listQuestionSolutions,
  listSolutionCandidates,
  updateQuestionSolution,
  withdrawQuestionSolution,
} from '../services/questionSolutions.js'

const router = Router()
const handle =
  (operation: (req: any, user: TokenPayload) => Promise<unknown>, status = 200) =>
  async (req: any, res: any) => {
    try {
      const user = await requireUser(req, res)
      if (!user) return
      res.setHeader('Cache-Control', 'no-store')
      res.status(status).json({ code: 0, message: 'ok', data: await operation(req, authPayload(req)!) })
    } catch (error) {
      res
        .status(error instanceof RequestError || error instanceof AuthError ? error.status : 500)
        .json({
          code: error instanceof AuthError ? error.code : 40001,
          message:
            error instanceof RequestError || error instanceof AuthError
              ? error.message
              : '题解操作失败，请稍后重试',
          data: null,
        })
    }
  }
router.get(
  '/questions/:id/solutions',
  handle((req, user) => listQuestionSolutions(req.params.id, user, req.query)),
)
router.get(
  '/questions/:id/solution-candidates',
  handle((req, user) => listSolutionCandidates(req.params.id, user)),
)
router.post(
  '/questions/:id/solutions',
  handle((req, user) => createQuestionSolution(req.params.id, user, req.body), 201),
)
router.put(
  '/solutions/:id',
  handle((req, user) => updateQuestionSolution(req.params.id, user, req.body)),
)
router.delete(
  '/solutions/:id',
  handle((req, user) => withdrawQuestionSolution(req.params.id, user)),
)
export default router
