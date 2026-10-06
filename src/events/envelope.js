// 事件信封工具：规范化 JSON 与 SHA-256 哈希链。
// 哈希覆盖除 hash、signature 之外的全部字段；签名针对 hash 生成（见 signing.js）。
import { createHash, randomUUID } from "node:crypto";

const HASH_EXCLUDED = new Set(["hash", "signature", "co_signatures"]);

/** 稳定序列化：对象键递归排序，确保同一事实在任何机器上得到同一哈希。 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  // 跳过 undefined，与 JSON 持久化的字段取舍保持一致，保证落盘前后哈希相同。
  const keys = Object.keys(value).sort().filter((key) => value[key] !== undefined);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 计算事件哈希：先剔除 hash/signature 再规范化。 */
export function hashEvent(event) {
  const material = {};
  for (const [key, value] of Object.entries(event)) {
    if (!HASH_EXCLUDED.has(key)) material[key] = value;
  }
  return sha256Hex(canonicalize(material));
}

/** 生成事件标识。允许注入生成器以便测试得到确定标识。 */
export function newEventId(generate = randomUUID) {
  return `evt_${generate().replace(/-/g, "")}`;
}
