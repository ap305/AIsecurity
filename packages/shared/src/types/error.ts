/** Spec #3 错误码体系 */
export enum ErrorCode {
  /** 成功 */
  Success = 0,
  /** 参数错误 */
  BadRequest = 40001,
  /** 未认证 */
  Unauthorized = 40100,
  /** Token 过期 */
  TokenExpired = 40101,
  /** 无权限 */
  Forbidden = 40300,
  /** 资源不存在 */
  NotFound = 40400,
  /** 资源冲突 */
  Conflict = 40900,
  /** 服务器内部错误 */
  InternalError = 50000,
  /** 判题服务异常 */
  JudgeError = 50010,
  /** 沙箱异常 */
  SandboxError = 50011,
}
