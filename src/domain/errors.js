// 领域错误：携带机器可读 code，便于 API 层映射为状态码。
export class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    Object.assign(this, extra);
  }
}

export const fail = (code, message, extra) => {
  throw new DomainError(code, message, extra);
};
