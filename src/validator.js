// 领域事件信封的结构校验。哈希链完整性与业务规则由存储和命令处理器负责。

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_TYPES = [
  "RULE_VERSION_REGISTERED",
  "RULE_ACTIVATED",
  "ATHLETE_ELIGIBILITY_CONFIRMED",
  "EVENT_PROGRAM_DEFINED",
  "BOUT_SCHEDULED",
  "POOL_COMPOSED",
  "ROSTER_FINALIZED",
  "JUDGE_ASSIGNED",
  "JUDGE_REMOVED",
  "DEVICE_REGISTERED",
  "DEVICE_CALIBRATED",
  "DEVICE_DECLARED_UNRELIABLE",
  "ROUND_STARTED",
  "RAW_SCORE_SUBMITTED",
  "SENSOR_MESSAGE_INGESTED",
  "FOUL_RULED",
  "SCORE_CORRECTED",
  "TIEBREAK_RESOLVED",
  "RESULT_CANDIDATE_PROJECTED",
  "RESULT_CERTIFIED",
  "RESULT_PUBLISHED",
  "RESULT_LOCKED",
  "ADVANCEMENT_PROJECTED",
  "ADVANCEMENT_FROZEN",
  "ADVANCEMENT_UNFROZEN",
  "ADVANCEMENT_CONFIRMED",
  "APPEAL_FILED",
  "APPEAL_EVIDENCE_ACCEPTED",
  "APPEAL_REVIEW_LOGGED",
  "APPEAL_UPHELD",
  "APPEAL_REJECTED",
  "APPEAL_WITHDRAWN",
  "RECORD_CERTIFIED",
];

export const AGGREGATE_TYPES = [
  "competition_rule",
  "athlete_eligibility",
  "bout",
  "judge_assignment",
  "judge",
  "device",
  "score_evidence",
  "appeal_case",
  "result",
  "advancement_chain",
  "record",
];

const HASH_RE = /^[0-9a-f]{64}$/;

function isValidDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object") return ["事件必须是对象"];

  for (const name of required) {
    if (!(name in record) || record[name] === undefined || record[name] === null) {
      errors.push(`缺少字段：${name}`);
    }
  }
  if (errors.length > 0) return errors;

  if (typeof record.event_id !== "string" || record.event_id.length === 0) errors.push("event_id 必须是非空字符串");
  if (!EVENT_TYPES.includes(record.event_type)) errors.push(`未知 event_type：${record.event_type}`);
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0) errors.push("aggregate_id 必须是非空字符串");
  if (typeof record.summary !== "string" || record.summary.length === 0) errors.push("summary 必须是非空字符串");

  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if ("seq" in record && record.seq !== undefined && (!Number.isInteger(record.seq) || record.seq < 1)) {
    errors.push("seq 必须是正整数");
  }

  if (!isValidDateTime(record.occurred_at)) errors.push("occurred_at 必须是合法时间");
  if ("recorded_at" in record && record.recorded_at !== undefined) {
    if (!isValidDateTime(record.recorded_at)) {
      errors.push("recorded_at 必须是合法时间");
    } else if (Date.parse(record.recorded_at) < Date.parse(record.occurred_at)) {
      errors.push("recorded_at 不得早于 occurred_at（离线补传只能更晚接收）");
    }
  }

  if ("payload" in record && record.payload !== null && (typeof record.payload !== "object" || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  for (const name of ["causation_id", "correction_of", "correlation_id", "idempotency_key"]) {
    if (record[name] !== undefined && record[name] !== null && (typeof record[name] !== "string" || record[name].length === 0)) {
      errors.push(`${name} 必须是非空字符串`);
    }
  }
  for (const name of ["prev_hash", "hash"]) {
    if (name in record && record[name] !== undefined && !HASH_RE.test(record[name])) {
      errors.push(`${name} 必须是 64 位十六进制 SHA-256`);
    }
  }
  const checkSignature = (sig, label) => {
    if (sig === null || typeof sig !== "object" || typeof sig.official_id !== "string" || sig.official_id.length === 0 ||
        typeof sig.role !== "string" || sig.role.length === 0 || typeof sig.value !== "string" || sig.value.length === 0) {
      errors.push(`${label} 必须包含 official_id/role/alg/value`);
    }
  };
  if ("signature" in record && record.signature !== undefined) checkSignature(record.signature, "signature");
  if ("co_signatures" in record && record.co_signatures !== undefined) {
    if (!Array.isArray(record.co_signatures)) errors.push("co_signatures 必须是数组");
    else record.co_signatures.forEach((sig) => checkSignature(sig, "co_signatures[]"));
  }
  if ("actor" in record && record.actor !== undefined) {
    const actor = record.actor;
    if (actor === null || typeof actor !== "object" || typeof actor.id !== "string" || actor.id.length === 0) {
      errors.push("actor.id 必须是非空字符串");
    }
    if (!actor || typeof actor.role !== "string" || actor.role.length === 0) {
      errors.push("actor.role 必须是非空字符串");
    }
  }
  return errors;
}
