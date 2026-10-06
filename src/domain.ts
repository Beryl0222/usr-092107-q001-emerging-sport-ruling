/** 新兴赛项裁判证据台使用的领域事件信封与词汇表。 */

export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  /** 事实发生时间（离线补传可早于 stored_at）。 */
  occurred_at: string;
  /** 聚合内连续版本，从 1 起。 */
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
  /** 触发本事件的命令或上游事件 id。 */
  causation_id?: string;
  /** 同一场比赛/申诉链共享的关联 id（通常取 bout_id）。 */
  correlation_id?: string;
  /** 离线设备补传去重键。 */
  idempotency_key?: string;

  // —— 以下字段仅由事件存储赋值 ——
  content_hash?: string;
  prev_hash?: string;
  seq?: number;
  stored_at?: string;
}

export type EventType =
  // 规则版本
  | "RULEBOOK_PUBLISHED"
  | "RULEBOOK_ACTIVATED"
  // 运动员与资格
  | "ATHLETE_REGISTERED"
  | "ELIGIBILITY_GRANTED"
  | "ELIGIBILITY_REVOKED"
  // 裁判、回避与指派
  | "OFFICIAL_REGISTERED"
  | "CONFLICT_DECLARED"
  | "PANEL_ASSIGNED"
  | "JUDGE_REPLACED"
  // 设备
  | "DEVICE_REGISTERED"
  | "DEVICE_CALIBRATED"
  | "DEVICE_BOUND"
  // 赛程与抽签
  | "SESSION_SCHEDULED"
  | "DRAW_CONDUCTED"
  | "DRAW_PUBLISHED"
  | "BOUT_SCHEDULED"
  | "BOUT_PARTICIPANT_QUALIFIED"
  | "ROUND_STARTED"
  | "ROUND_ENDED"
  | "BOUT_ENDED"
  // 证据、处罚与改判
  | "EVIDENCE_RECORDED"
  | "EVIDENCE_QUARANTINED"
  | "PENALTY_IMPOSED"
  | "PENALTY_REVOKED"
  | "RULING_AMENDED"
  // 申诉与复核
  | "APPEAL_FILED"
  | "APPEAL_EVIDENCE_ADDED"
  | "REVIEW_OPENED"
  | "REVIEW_OPINION_ISSUED"
  | "APPEAL_DECIDED"
  | "APPEAL_WITHDRAWN"
  // 晋级
  | "ADVANCEMENT_FROZEN"
  | "ADVANCEMENT_RELEASED"
  | "ADVANCEMENT_CONFIRMED"
  // 成绩
  | "TIE_RESOLVED"
  | "RESULT_CANDIDATE_COMPUTED"
  | "RESULT_CERTIFIED"
  | "RESULT_PUBLISHED"
  // 奥运资格与纪录
  | "OLYMPIC_QUOTA_ALLOCATED"
  | "RECORD_RATIFIED";

export type AggregateType =
  | "rulebook"
  | "athlete"
  | "eligibility"
  | "official"
  | "panel"
  | "device"
  | "session"
  | "draw"
  | "bout"
  | "evidence"
  | "sanction"
  | "appeal_case"
  | "progression"
  | "bout_result"
  | "olympic_quota"
  | "record";

export type Sport = "surfing" | "mma" | "virtual_taekwondo";

/** 证据种类：主观评分 / 记分卡 / 终止结果 / 传感器命中 / 艺术分。 */
export type EvidenceKind =
  | "wave_judge_score"
  | "round_scorecard"
  | "bout_outcome"
  | "sensor_hit"
  | "judge_art_score";
