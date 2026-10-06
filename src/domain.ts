/** 新兴赛项裁判证据台使用的领域事件信封。记录一经追加，字段永不原地改写。 */

export type ActorRole =
  | "system"
  | "rule_committee"
  | "technical_official"
  | "head_judge"
  | "judge"
  | "device"
  | "jury"
  | "result_arbiter"
  | "chief_recorder"
  | "delegation"
  | "service";

export interface Actor {
  id: string;
  role: ActorRole;
  name?: string;
}

/** 事件类型：命名即领域语言。 */
export type DomainEventType =
  | "RULE_VERSION_REGISTERED"
  | "RULE_ACTIVATED"
  | "ATHLETE_ELIGIBILITY_CONFIRMED"
  | "EVENT_PROGRAM_DEFINED"
  | "BOUT_SCHEDULED"
  | "POOL_COMPOSED"
  | "ROSTER_FINALIZED"
  | "JUDGE_ASSIGNED"
  | "JUDGE_REMOVED"
  | "DEVICE_REGISTERED"
  | "DEVICE_CALIBRATED"
  | "DEVICE_DECLARED_UNRELIABLE"
  | "ROUND_STARTED"
  | "RAW_SCORE_SUBMITTED"
  | "SENSOR_MESSAGE_INGESTED"
  | "FOUL_RULED"
  | "SCORE_CORRECTED"
  | "TIEBREAK_RESOLVED"
  | "RESULT_CANDIDATE_PROJECTED"
  | "RESULT_CERTIFIED"
  | "RESULT_PUBLISHED"
  | "RESULT_LOCKED"
  | "ADVANCEMENT_PROJECTED"
  | "ADVANCEMENT_FROZEN"
  | "ADVANCEMENT_UNFROZEN"
  | "ADVANCEMENT_CONFIRMED"
  | "APPEAL_FILED"
  | "APPEAL_EVIDENCE_ACCEPTED"
  | "APPEAL_REVIEW_LOGGED"
  | "APPEAL_UPHELD"
  | "APPEAL_REJECTED"
  | "APPEAL_WITHDRAWN"
  | "RECORD_CERTIFIED";

export type AggregateType =
  | "competition_rule"
  | "athlete_eligibility"
  | "bout"
  | "judge_assignment"
  | "judge"
  | "device"
  | "score_evidence"
  | "appeal_case"
  | "result"
  | "advancement_chain"
  | "record";

export interface DomainEvent {
  /** 全局唯一事件标识，一经分配永不复用。 */
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  /** 决定实际发生时间（设备时间或裁决时间）。 */
  occurred_at: string;
  /** 证据台接收时间；离线补传时晚于 occurred_at。 */
  recorded_at?: string;
  /** 聚合内严格递增版本号。 */
  version: number;
  /** 全局追加序号，确定全库先后关系。 */
  seq?: number;
  summary: string;
  payload?: Record<string, unknown>;
  /** 触发本事件的命令或上游事件标识。 */
  causation_id?: string;
  /** 改判/更正引用的原始事件标识；原始记录保留不删。 */
  correction_of?: string;
  /** 同一场比赛/流程的关联标识（通常为 bout_id）。 */
  correlation_id?: string;
  /** 离线补传去重键；同一键重复提交只生效一次。 */
  idempotency_key?: string;
  actor?: Actor;
  prev_hash?: string;
  hash?: string;
  /** 正式发布事件的操作者签名（签署服务注入）。 */
  signature?: Signature;
  /** 会签签名（如纪录认证需裁判长+总记录长共同签署）。 */
  co_signatures?: Signature[];
}

export interface Signature {
  official_id: string;
  role: string;
  name?: string;
  alg: string;
  value: string;
}

/** 赛项标识。 */
export type SportCode = "surfing" | "mma" | "virtual_taekwondo";

/** 证据来源渠道。 */
export type EvidenceChannel = "judge" | "sensor" | "referee" | "review";

/** 结果生命周期：自动计算只到 candidate，签署后 certified，公告发布后 published。 */
export type ResultStatus = "candidate" | "certified" | "published" | "superseded";
