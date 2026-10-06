import { createHash, randomUUID } from "node:crypto";

/**
 * 事件信封：所有决定都通过 appendEvent 落入仅追加日志。
 * 信封字段保持与 contracts/domain.schema.json 一致。
 * 记录一经接收，event_id / occurred_at / version 不得原地改写；
 * 更正只能产生引用原记录的后继事件（RULING_AMENDED 等）。
 */

export const GENESIS_HASH = "0".repeat(64);

const ENVELOPE_KEYS = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "payload",
  "causation_id",
  "correlation_id",
  "idempotency_key",
];

/** 递归按键排序的规范化 JSON 材料：对字段书写顺序不敏感。 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]);
  }
  return value;
}

/** 计算事件正文哈希：不含 content_hash / prev_hash / seq / stored_at。 */
export function hashEvent(event) {
  const body = Object.fromEntries(
    ENVELOPE_KEYS.filter((key) => event[key] !== undefined).map((key) => [key, event[key]]),
  );
  return createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
}

let clock = () => new Date().toISOString();

/** 允许测试注入固定时钟。 */
export function setClock(fn) {
  clock = fn;
}

export function nowIso() {
  return clock();
}

/**
 * 构造一条事件（尚未入链）。
 * @param {object} fields
 * @param {string} fields.event_type
 * @param {string} fields.aggregate_type
 * @param {string} fields.aggregate_id
 * @param {number} fields.version 该聚合内的版本号，从 1 起
 * @param {string} fields.summary
 * @param {object} [fields.payload]
 * @param {string} [fields.event_id]
 * @param {string} [fields.occurred_at]
 * @param {string} [fields.causation_id]
 * @param {string} [fields.correlation_id]
 * @param {string} [fields.idempotency_key]
 */
export function makeEvent(fields) {
  for (const key of [
    "event_type",
    "aggregate_type",
    "aggregate_id",
    "version",
    "summary",
  ]) {
    if (fields[key] === undefined || fields[key] === null || fields[key] === "") {
      throw new Error(`事件缺少必填字段：${key}`);
    }
  }
  if (!Number.isInteger(fields.version) || fields.version < 1) {
    throw new Error("version 必须是正整数");
  }
  return {
    event_id: fields.event_id ?? `evt_${randomUUID()}`,
    event_type: fields.event_type,
    aggregate_type: fields.aggregate_type,
    aggregate_id: fields.aggregate_id,
    occurred_at: fields.occurred_at ?? clock(),
    version: fields.version,
    summary: fields.summary,
    ...(fields.payload !== undefined && { payload: fields.payload }),
    ...(fields.causation_id !== undefined && { causation_id: fields.causation_id }),
    ...(fields.correlation_id !== undefined && { correlation_id: fields.correlation_id }),
    ...(fields.idempotency_key !== undefined && {
      idempotency_key: fields.idempotency_key,
    }),
  };
}
