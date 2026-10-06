const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_TYPES = [
  "RULEBOOK_PUBLISHED",
  "RULEBOOK_ACTIVATED",
  "ATHLETE_REGISTERED",
  "ELIGIBILITY_GRANTED",
  "ELIGIBILITY_REVOKED",
  "OFFICIAL_REGISTERED",
  "CONFLICT_DECLARED",
  "PANEL_ASSIGNED",
  "JUDGE_REPLACED",
  "DEVICE_REGISTERED",
  "DEVICE_CALIBRATED",
  "DEVICE_BOUND",
  "SESSION_SCHEDULED",
  "DRAW_CONDUCTED",
  "DRAW_PUBLISHED",
  "BOUT_SCHEDULED",
  "BOUT_PARTICIPANT_QUALIFIED",
  "ROUND_STARTED",
  "ROUND_ENDED",
  "BOUT_ENDED",
  "EVIDENCE_RECORDED",
  "EVIDENCE_QUARANTINED",
  "PENALTY_IMPOSED",
  "PENALTY_REVOKED",
  "RULING_AMENDED",
  "APPEAL_FILED",
  "APPEAL_EVIDENCE_ADDED",
  "REVIEW_OPENED",
  "REVIEW_OPINION_ISSUED",
  "APPEAL_DECIDED",
  "APPEAL_WITHDRAWN",
  "ADVANCEMENT_FROZEN",
  "ADVANCEMENT_RELEASED",
  "ADVANCEMENT_CONFIRMED",
  "TIE_RESOLVED",
  "RESULT_CANDIDATE_COMPUTED",
  "RESULT_CERTIFIED",
  "RESULT_PUBLISHED",
  "OLYMPIC_QUOTA_ALLOCATED",
  "RECORD_RATIFIED",
];

export const AGGREGATE_TYPES = [
  "rulebook",
  "athlete",
  "eligibility",
  "official",
  "panel",
  "device",
  "session",
  "draw",
  "bout",
  "evidence",
  "sanction",
  "appeal_case",
  "progression",
  "bout_result",
  "olympic_quota",
  "record",
];

/** 信封基础校验：必填字段、版本号与枚举取值。 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  return errors;
}
