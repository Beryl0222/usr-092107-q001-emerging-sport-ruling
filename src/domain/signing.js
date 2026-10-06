// 签署服务：对事件哈希做 HMAC-SHA256 签名。
// 正式发布（certify/publish/record）必须带满足签署权限的签名，自动计算无权发布。
// 这里用每官员一把对称密钥演示验签；生产可替换为非对称证书验签，接口不变。
import { createHmac, timingSafeEqual } from "node:crypto";
import { fail } from "./errors.js";

export class SigningRegistry {
  constructor() {
    /** @type {Map<string, {secret:string, role:string, name?:string}>} */
    this.officials = new Map();
  }

  enroll(official_id, role, secret, name) {
    this.officials.set(official_id, { secret, role, name });
  }

  sign(official_id, eventHash) {
    const o = this.officials.get(official_id);
    if (!o) fail("SIGNER_UNKNOWN", `未登记的签署人：${official_id}`);
    const value = createHmac("sha256", o.secret).update(eventHash, "utf8").digest("hex");
    return { official_id, role: o.role, name: o.name, alg: "HS256", value };
  }

  verify(signature, eventHash) {
    if (!signature || typeof signature.value !== "string") return false;
    const o = this.officials.get(signature.official_id);
    if (!o || o.role !== signature.role) return false;
    const expected = createHmac("sha256", o.secret).update(eventHash, "utf8").digest("hex");
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature.value));
  }

  /**
   * 校验一组签名满足签署策略。
   * @param {{minSignatures?:number, anyOfRoles?:string[], allOfRoles?:string[]}} policy
   */
  authorize(signatures, eventHash, policy) {
    const sigs = signatures ?? [];
    const valid = sigs.filter((s) => this.verify(s, eventHash));
    if (valid.length !== sigs.length) fail("SIGNATURE_INVALID", "存在无法验签的签名");
    if (sigs.length === 0) fail("SIGNATURE_REQUIRED", "正式发布必须携带签名");
    const roles = new Set(valid.map((s) => s.role));
    if (policy.minSignatures && valid.length < policy.minSignatures) {
      fail("SIGNATURE_QUORUM", `至少需要 ${policy.minSignatures} 个有效签名，实际 ${valid.length} 个`);
    }
    if (policy.anyOfRoles && !policy.anyOfRoles.some((r) => roles.has(r))) {
      fail("SIGNATURE_ROLE", `签署角色不足，需其一：${policy.anyOfRoles.join("、")}`);
    }
    if (policy.allOfRoles && !policy.allOfRoles.every((r) => roles.has(r))) {
      fail("SIGNATURE_ROLE", `缺少必需签署角色：${policy.allOfRoles.filter((r) => !roles.has(r)).join("、")}`);
    }
    // 同一官员重复签名不增加效力
    if (new Set(valid.map((s) => s.official_id)).size !== valid.length) {
      fail("SIGNATURE_DUPLICATE", "同一签署人不得重复签名");
    }
    return valid;
  }
}
