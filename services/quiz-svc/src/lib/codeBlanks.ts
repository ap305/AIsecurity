import { RequestError } from './prdContract.js'

// Templates may declare multiple editable regions. Without markers the entire template is one editable region.
export function validateCodeBlanks(template: string | null, code: string) {
  if (!template || !template.includes('# BEGIN STUDENT')) return
  const parts = template.replace(/\r\n/g, '\n').split(/# BEGIN STUDENT[^\n]*\n[\s\S]*?# END STUDENT/g)
  const submitted = code.replace(/\r\n/g, '\n').split(/# BEGIN STUDENT[^\n]*\n[\s\S]*?# END STUDENT/g)
  if (parts.length < 2 || parts.length !== submitted.length || parts.some((part, i) => part !== submitted[i]))
    throw new RequestError('请只修改 BEGIN STUDENT 与 END STUDENT 之间的填空区域')
}
