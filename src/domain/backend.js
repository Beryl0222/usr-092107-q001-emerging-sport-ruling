// 新兴赛项裁判与成绩后端：全部领域命令的唯一入口。
// 不变量：
//  - 所有决定都追加为带哈希链的事件；人工改判引用原记录，绝不覆盖。
//  - 自动计算只产生 RESULT_CANDIDATE_PROJECTED；certified/published/record 必须验签。
//  - 申诉只冻结受影响的晋级链闭包，其余场次照常推进。
//  - 奥运资格赛结果发布后即 LOCKED；任何改写只能走申诉改判流程并重新签署发布。
import { EventStore } from "../events/store.js";
import { hashEvent } from "../events/envelope.js";
import { replayAll, activeRuleAt, deviceUsableAt } from "./fold.js";
import { buildCandidate } from "./compute.js";
import { fail } from "./errors.js";

const SPORTS = new Set(["surfing", "mma", "virtual_taekwondo"]);

export class RulingBackend {
  /**
   * @param {object} opts
   * @param {EventStore} opts.store
   * @param {import("./signing.js").SigningRegistry} opts.signing
   * @param {() => string} [opts.clock]
   */
  constructor({ store, signing, clock = () => new Date().toISOString() }) {
    this.store = store;
    this.signing = signing;
    this.clock = clock;
    this._stateCache = null;
  }

  now() {
    return this.clock();
  }

  /** 从事件流重放当前状态（事件数未变时使用缓存）。 */
  state() {
    if (!this._stateCache || this._stateCache.seq !== this.store.events.length) {
      this._stateCache = { seq: this.store.events.length, state: replayAll(this.store.all()) };
    }
    return this._stateCache.state;
  }

  invalidate() {
    this._stateCache = null;
  }

  // ---------- 内部工具 ----------

  _emit(draft, seal) {
    const { event } = this.store.append(
      {
        occurred_at: this.now(),
        ...draft,
      },
      seal ? { seal } : undefined,
    );
    this.invalidate();
    return event;
  }

  /** 依据签署策略预检签名人角色/数量，返回 store 的 seal 钩子。 */
  _sealFor(officialIds, policy) {
    const ids = officialIds ?? [];
    if (ids.length === 0) fail("SIGNATURE_REQUIRED", "正式发布必须携带签名");
    const metas = ids.map((id) => {
      const o = this.signing.officials.get(id);
      if (!o) fail("SIGNER_UNKNOWN", `未登记的签署人：${id}`);
      return { official_id: id, role: o.role };
    });
    if (new Set(ids).size !== ids.length) fail("SIGNATURE_DUPLICATE", "同一签署人不得重复签名");
    if (policy.minSignatures && ids.length < policy.minSignatures) fail("SIGNATURE_QUORUM", `至少需要 ${policy.minSignatures} 个签名，实际 ${ids.length} 个`);
    const roles = new Set(metas.map((m) => m.role));
    if (policy.anyOfRoles && !policy.anyOfRoles.some((r) => roles.has(r))) fail("SIGNATURE_ROLE", `签署角色不足，需其一：${policy.anyOfRoles.join("、")}`);
    if (policy.allOfRoles && !policy.allOfRoles.every((r) => roles.has(r))) fail("SIGNATURE_ROLE", `缺少必需签署角色：${policy.allOfRoles.filter((r) => !roles.has(r)).join("、")}`);
    return (event) => {
      const made = ids.map((id) => this.signing.sign(id, event.hash));
      // 追加后再验签一次，形成闭环。
      for (const sig of made) {
        if (!this.signing.verify(sig, event.hash)) fail("SIGNATURE_INVALID", "签名验签失败");
      }
      event.signature = made[0];
      if (made.length > 1) event.co_signatures = made.slice(1);
    };
  }

  _getBout(boutId) {
    const bout = this.state().bouts.get(boutId);
    if (!bout) fail("BOUT_NOT_FOUND", `比赛不存在：${boutId}`);
    return bout;
  }

  _getResult(boutId) {
    const result = this.state().results.get(boutId);
    if (!result) fail("RESULT_NOT_FOUND", `该场尚无结果记录：${boutId}`);
    return result;
  }

  _roundStartedAt(bout, round) {
    const started = this.store
      .byCorrelation(bout.bout_id)
      .filter((e) => e.event_type === "ROUND_STARTED" && e.payload.round === round)
      .at(-1);
    return started?.occurred_at ?? bout.scheduled_at;
  }

  /** 证据窗口：以该轮开始（无轮次则以排赛时间）起算；补传宽限只看接收时间。 */
  _assertEvidenceWindow(bout, round, occurredAt, recordedAt) {
    const rule = activeRuleAt(this.state(), bout.sport, occurredAt ?? this.now());
    const minutes = rule?.windows?.evidence_minutes;
    if (minutes === undefined) return; // 规则未设窗口则不限制
    const startAt = this._roundStartedAt(bout, round);
    const close = Date.parse(startAt) + minutes * 60_000;
    if (Date.parse(occurredAt ?? this.now()) > close) fail("EVIDENCE_WINDOW_CLOSED", `证据发生时间超出规则窗口（截止 ${new Date(close).toISOString()}）`, { window_end: new Date(close).toISOString() });
    const grace = rule.windows.ingest_grace_minutes ?? 0;
    if (recordedAt && Date.parse(recordedAt) > close + grace * 60_000) {
      fail("EVIDENCE_INGEST_WINDOW_CLOSED", `补传接收超出宽限窗口（截止 ${new Date(close + grace * 60_000).toISOString()}）`);
    }
  }

  _assertAdvancementOpen(bout) {
    if (bout.frozen) fail("CHAIN_FROZEN", `申诉期间该场所在晋级链冻结中：${bout.freeze_reasons.join("、")}`);
  }

  _projectCandidate(bout, { supersedes = true, causationId = null } = {}) {
    // 必须基于最新重放状态计算：调用方持有的 bout 可能是本次命令追加事件之前的旧快照。
    const freshBout = this.state().bouts.get(bout.bout_id);
    const candidate = buildCandidate(this.state(), freshBout);
    const pending = this.state().results.get(bout.bout_id)?.pending;
    return this._emit({
      event_type: "RESULT_CANDIDATE_PROJECTED",
      aggregate_type: "result",
      aggregate_id: `result-${bout.bout_id}`,
      summary: `自动计算候选名次（${bout.sport}）`,
      correlation_id: bout.bout_id,
      causation_id: causationId,
      payload: {
        bout_id: bout.bout_id,
        sport: bout.sport,
        candidate,
        basis_seq: this.store.events.length,
        supersedes_event_id: supersedes ? pending?.candidate_event_id ?? null : null,
      },
      actor: { id: "ruling-engine", role: "system" },
    });
  }

  // ---------- 规则版本 ----------

  registerRuleVersion(cmd) {
    if (!SPORTS.has(cmd.sport)) fail("UNKNOWN_SPORT", `未知赛项：${cmd.sport}`);
    if (this.state().rules.has(cmd.rule_id)) fail("RULE_EXISTS", `规则版本已存在：${cmd.rule_id}`);
    return this._emit({
      event_type: "RULE_VERSION_REGISTERED",
      aggregate_type: "competition_rule",
      aggregate_id: cmd.rule_id,
      summary: `登记 ${cmd.sport} 规则版本 ${cmd.version_label ?? cmd.rule_id}`,
      payload: { sport: cmd.sport, version_label: cmd.version_label, windows: cmd.windows ?? {}, scoring_params: cmd.scoring_params ?? {} },
      actor: cmd.actor,
    });
  }

  activateRule(cmd) {
    const rule = this.state().rules.get(cmd.rule_id);
    if (!rule) fail("RULE_NOT_FOUND", `规则版本不存在：${cmd.rule_id}`);
    return this._emit({
      event_type: "RULE_ACTIVATED",
      aggregate_type: "competition_rule",
      aggregate_id: cmd.rule_id,
      summary: `激活 ${rule.sport} 规则版本 ${rule.version_label ?? cmd.rule_id}`,
      payload: { sport: rule.sport, note: cmd.note },
      actor: cmd.actor ?? { id: "rule-committee", role: "rule_committee" },
    });
  }

  // ---------- 运动员资格 ----------

  confirmEligibility(cmd) {
    return this._emit({
      event_type: "ATHLETE_ELIGIBILITY_CONFIRMED",
      aggregate_type: "athlete_eligibility",
      aggregate_id: `eligibility-${cmd.athlete_id}`,
      summary: `运动员 ${cmd.athlete_id} 资格状态：${cmd.status}`,
      payload: {
        athlete_id: cmd.athlete_id,
        nation: cmd.nation,
        status: cmd.status,
        olympic_quota: cmd.olympic_quota ?? false,
        reason: cmd.reason,
        rule_version: cmd.rule_version,
      },
      actor: cmd.actor ?? { id: "tech-office", role: "technical_official" },
    });
  }

  // ---------- 分组轮次 ----------

  defineProgram(cmd) {
    return this._emit({
      event_type: "EVENT_PROGRAM_DEFINED",
      aggregate_type: "bout",
      aggregate_id: cmd.program_id,
      summary: `定义赛程 ${cmd.program_id}（${cmd.sport}）`,
      payload: { sport: cmd.sport, phases: cmd.phases ?? [], bout_ids: cmd.bout_ids ?? [] },
      actor: cmd.actor ?? { id: "tech-office", role: "technical_official" },
    });
  }

  scheduleBout(cmd) {
    if (!SPORTS.has(cmd.sport)) fail("UNKNOWN_SPORT", `未知赛项：${cmd.sport}`);
    if (this.state().bouts.has(cmd.bout_id)) fail("BOUT_EXISTS", `比赛已排定：${cmd.bout_id}`);
    const rule = activeRuleAt(this.state(), cmd.sport, cmd.occurred_at ?? this.now());
    if (!rule) fail("NO_ACTIVE_RULE", `${cmd.sport} 在该时间没有已激活的规则版本`);
    return this._emit({
      event_type: "BOUT_SCHEDULED",
      aggregate_type: "bout",
      aggregate_id: cmd.bout_id,
      summary: `排定 ${cmd.sport} 比赛 ${cmd.bout_id}（${cmd.phase ?? "预赛"} 第 ${cmd.round_no ?? 1} 轮）`,
      correlation_id: cmd.bout_id,
      payload: {
        sport: cmd.sport,
        phase: cmd.phase,
        round_no: cmd.round_no ?? 1,
        athlete_ids: cmd.athlete_ids ?? [],
        sides: cmd.sides ?? null,
        chain_id: cmd.chain_id ?? null,
        slot: cmd.slot ?? null,
        olympic_qualification: cmd.olympic_qualification ?? false,
        rule_version: cmd.rule_version ?? rule.rule_id,
      },
      actor: cmd.actor ?? { id: "tech-office", role: "technical_official" },
    });
  }

  composePool(cmd) {
    return this._emit({
      event_type: "POOL_COMPOSED",
      aggregate_type: "bout",
      aggregate_id: cmd.pool_id,
      summary: `组成分组 ${cmd.pool_id}`,
      payload: { sport: cmd.sport, pool_of: cmd.program_id ?? null, athlete_ids: cmd.athlete_ids ?? [], bout_ids: cmd.bout_ids ?? [] },
      actor: cmd.actor ?? { id: "tech-office", role: "technical_official" },
    });
  }

  finalizeRoster(cmd) {
    const bout = this._getBout(cmd.bout_id);
    const athleteIds = cmd.athlete_ids ?? bout.athlete_ids;
    for (const id of athleteIds) {
      const elig = this.state().eligibility.get(id);
      if (!elig) fail("ELIGIBILITY_MISSING", `运动员 ${id} 尚无资格记录，不得列入名单`);
      if (elig.status !== "eligible") fail("ATHLETE_INELIGIBLE", `运动员 ${id} 当前状态 ${elig.status}，不得参赛`, { athlete_id: id, status: elig.status });
    }
    return this._emit({
      event_type: "ROSTER_FINALIZED",
      aggregate_type: "bout",
      aggregate_id: bout.bout_id,
      summary: `确认 ${bout.bout_id} 参赛名单`,
      correlation_id: bout.bout_id,
      payload: { athlete_ids: athleteIds, sides: cmd.sides ?? bout.sides },
      actor: cmd.actor ?? { id: "tech-office", role: "technical_official" },
    });
  }

  startRound(cmd) {
    const bout = this._getBout(cmd.bout_id);
    this._assertAdvancementOpen(bout);
    return this._emit({
      event_type: "ROUND_STARTED",
      aggregate_type: "bout",
      aggregate_id: bout.bout_id,
      summary: `${bout.bout_id} 第 ${cmd.round} 轮开始`,
      correlation_id: bout.bout_id,
      payload: { round: cmd.round },
      actor: cmd.actor ?? { id: "referee", role: "technical_official" },
    });
  }

  // ---------- 裁判指派与回避 ----------

  assignJudge(cmd) {
    const bout = this._getBout(cmd.bout_id);
    const existing = this.state().assignmentsByBout.get(cmd.bout_id)?.get(cmd.judge_id);
    if (existing?.status === "assigned") fail("JUDGE_ALREADY_ASSIGNED", `裁判 ${cmd.judge_id} 已在执裁本场`);

    // 回避冲突：同国籍、明示利害关系，或与其已执裁的另一场当事人重合。
    const profile = this.state().judges.get(cmd.judge_id);
    const judgeNations = new Set(cmd.nations ?? profile?.nations ?? []);
    const declaredConflicts = new Set(cmd.conflicts ?? profile?.conflicts ?? []);
    const conflicts = [];
    for (const athleteId of bout.athlete_ids) {
      const elig = this.state().eligibility.get(athleteId);
      const reasons = [];
      if (elig?.nation && judgeNations.has(elig.nation)) reasons.push(`同国籍（${elig.nation}）`);
      if (declaredConflicts.has(athleteId)) reasons.push("明示利害关系");
      if (reasons.length > 0) conflicts.push({ athlete_id: athleteId, reasons });
    }
    if (conflicts.length > 0) {
      fail("JUDGE_CONFLICT", `裁判 ${cmd.judge_id} 与本场存在回避事由，不得指派`, { conflicts });
    }

    return this._emit({
      event_type: "JUDGE_ASSIGNED",
      aggregate_type: "judge_assignment",
      aggregate_id: `assign-${cmd.bout_id}-${cmd.judge_id}`,
      summary: `指派裁判 ${cmd.judge_id} 执裁 ${cmd.bout_id}（${cmd.role}）`,
      correlation_id: cmd.bout_id,
      payload: {
        bout_id: cmd.bout_id,
        judge_id: cmd.judge_id,
        judge_name: cmd.judge_name ?? profile?.name,
        role: cmd.role,
        nations: cmd.nations ?? profile?.nations ?? [],
        conflicts: cmd.conflicts ?? profile?.conflicts ?? [],
      },
      actor: cmd.actor ?? { id: "head-judge", role: "head_judge" },
    });
  }

  removeJudge(cmd) {
    this._getBout(cmd.bout_id);
    const current = this.state().assignmentsByBout.get(cmd.bout_id)?.get(cmd.judge_id);
    if (!current || current.status !== "assigned") fail("JUDGE_NOT_ASSIGNED", `裁判 ${cmd.judge_id} 当前未执裁本场`);
    return this._emit({
      event_type: "JUDGE_REMOVED",
      aggregate_type: "judge_assignment",
      aggregate_id: `assign-${cmd.bout_id}-${cmd.judge_id}`,
      summary: `撤换裁判 ${cmd.judge_id}：${cmd.reason}`,
      correlation_id: cmd.bout_id,
      payload: { bout_id: cmd.bout_id, judge_id: cmd.judge_id, reason: cmd.reason },
      actor: cmd.actor ?? { id: "head-judge", role: "head_judge" },
    });
  }

  // ---------- 设备登记与校准 ----------

  registerDevice(cmd) {
    if (this.state().devices.has(cmd.device_id)) fail("DEVICE_EXISTS", `设备已登记：${cmd.device_id}`);
    return this._emit({
      event_type: "DEVICE_REGISTERED",
      aggregate_type: "device",
      aggregate_id: cmd.device_id,
      summary: `登记 ${cmd.kind ?? "传感器"} 设备 ${cmd.device_id}`,
      payload: { sport: cmd.sport, kind: cmd.kind ?? "sensor" },
      actor: cmd.actor ?? { id: "tech-office", role: "technical_official" },
    });
  }

  calibrateDevice(cmd) {
    const device = this.state().devices.get(cmd.device_id);
    if (!device) fail("DEVICE_NOT_FOUND", `设备未登记：${cmd.device_id}`);
    if (!["passed", "failed"].includes(cmd.result)) fail("BAD_CALIBRATION", "校准结果必须是 passed 或 failed");
    return this._emit({
      event_type: "DEVICE_CALIBRATED",
      aggregate_type: "device",
      aggregate_id: cmd.device_id,
      summary: `设备 ${cmd.device_id} 校准${cmd.result === "passed" ? "通过" : "未通过"}`,
      payload: { result: cmd.result, tolerance: cmd.tolerance ?? null, by: cmd.by, note: cmd.note },
      actor: cmd.actor ?? { id: "tech-office", role: "technical_official" },
    });
  }

  declareDeviceUnreliable(cmd) {
    const device = this.state().devices.get(cmd.device_id);
    if (!device) fail("DEVICE_NOT_FOUND", `设备未登记：${cmd.device_id}`);
    return this._emit({
      event_type: "DEVICE_DECLARED_UNRELIABLE",
      aggregate_type: "device",
      aggregate_id: cmd.device_id,
      summary: `设备 ${cmd.device_id} 被宣布不可靠：${cmd.reason ?? ""}`,
      payload: { reason: cmd.reason },
      actor: cmd.actor ?? { id: "tech-office", role: "technical_official" },
    });
  }

  // ---------- 原始证据 ----------

  _assertJudgeOnBout(bout, judgeId) {
    const a = this.state().assignmentsByBout.get(bout.bout_id)?.get(judgeId);
    if (!a || a.status !== "assigned") fail("JUDGE_NOT_ASSIGNED", `裁判 ${judgeId} 未被指派执裁本场，评分不予接收`);
  }

  submitJudgeScore(cmd) {
    const bout = this._getBout(cmd.bout_id);
    this._assertJudgeOnBout(bout, cmd.judge_id);
    this._assertEvidenceWindow(bout, cmd.round, cmd.occurred_at, undefined);
    if (bout.sport === "surfing") {
      if (typeof cmd.score !== "number" || cmd.score < 0 || cmd.score > 10) fail("BAD_SCORE", "冲浪单浪评分必须在 0–10 之间");
      if (!cmd.wave_id) fail("BAD_SCORE", "冲浪评分必须带 wave_id");
    }
    if (bout.sport === "mma" && (!cmd.card || !Number.isFinite(cmd.card.red) || !Number.isFinite(cmd.card.blue))) {
      fail("BAD_SCORE", "综合格斗评分必须携带 card.red/card.blue");
    }
    return this._emit({
      event_type: "RAW_SCORE_SUBMITTED",
      aggregate_type: "score_evidence",
      aggregate_id: cmd.evidence_id ?? `score-${cmd.bout_id}-${cmd.judge_id}-${cmd.round}-${cmd.wave_id ?? "card"}-${Math.abs(hashString(cmd.judge_id + JSON.stringify(cmd.card ?? cmd.score))).toString(36).slice(0, 8)}`,
      occurred_at: cmd.occurred_at ?? this.now(),
      summary: `裁判 ${cmd.judge_id} 提交 ${bout.bout_id} 第 ${cmd.round} 轮原始评分`,
      correlation_id: cmd.bout_id,
      idempotency_key: cmd.idempotency_key,
      payload: {
        bout_id: cmd.bout_id,
        round: cmd.round,
        judge_id: cmd.judge_id,
        athlete_id: cmd.athlete_id,
        wave_id: cmd.wave_id,
        score: cmd.score,
        card: cmd.card,
      },
      actor: cmd.actor ?? { id: cmd.judge_id, role: "judge" },
    });
  }

  ingestSensorMessage(cmd) {
    const bout = this._getBout(cmd.bout_id);
    if (!cmd.idempotency_key) fail("IDEMPOTENCY_REQUIRED", "传感消息必须携带设备消息幂等键，重复/补传才能安全去重");
    const occurredAt = cmd.occurred_at ?? this.now();
    const device = this.state().devices.get(cmd.device_id);
    let valid = true;
    let invalidReason = null;
    if (!device) {
      valid = false;
      invalidReason = "device_unknown";
    } else if (device.sport && device.sport !== bout.sport) {
      valid = false;
      invalidReason = "device_wrong_sport";
    } else if (!deviceUsableAt(device, occurredAt)) {
      valid = false;
      invalidReason = device.unreliable_since && Date.parse(device.unreliable_since) <= Date.parse(occurredAt) ? "device_unreliable" : "not_calibrated_at_occurrence";
    } else if (!["red", "blue"].includes(cmd.side)) {
      valid = false;
      invalidReason = "unknown_side";
    }
    // 窗口校验失败不丢弃消息：标记为无效但留痕，便于审计与申诉。
    if (valid) {
      try {
        this._assertEvidenceWindow(bout, cmd.round, occurredAt, this.clock());
      } catch (err) {
        if (err.code === "EVIDENCE_WINDOW_CLOSED" || err.code === "EVIDENCE_INGEST_WINDOW_CLOSED") {
          valid = false;
          invalidReason = err.code;
        } else throw err;
      }
    }

    const { event, duplicate } = this.store.append({
      event_type: "SENSOR_MESSAGE_INGESTED",
      aggregate_type: "score_evidence",
      aggregate_id: cmd.message_id ?? `sensor-${cmd.bout_id}-${cmd.device_id}-${cmd.msg_seq ?? cmd.idempotency_key}`,
      occurred_at: occurredAt,
      summary: `设备 ${cmd.device_id} 消息 ${cmd.idempotency_key}（${valid ? "有效" : `无效：${invalidReason}`}）`,
      correlation_id: cmd.bout_id,
      idempotency_key: cmd.idempotency_key,
      payload: {
        bout_id: cmd.bout_id,
        round: cmd.round,
        device_id: cmd.device_id,
        msg_seq: cmd.msg_seq,
        side: cmd.side,
        action: cmd.action,
        value: cmd.value,
        valid,
        invalid_reason: invalidReason,
      },
      actor: cmd.actor ?? { id: cmd.device_id, role: "device" },
    });
    this.invalidate();
    return { event, duplicate, valid, invalid_reason: invalidReason };
  }

  ruleFoul(cmd) {
    const bout = this._getBout(cmd.bout_id);
    this._assertEvidenceWindow(bout, cmd.round, cmd.occurred_at, undefined);
    return this._emit({
      event_type: "FOUL_RULED",
      aggregate_type: "score_evidence",
      aggregate_id: cmd.ruling_id ?? `foul-${cmd.bout_id}-${cmd.round}-${cmd.code}-${Date.parse(cmd.occurred_at ?? this.now())}`,
      occurred_at: cmd.occurred_at ?? this.now(),
      summary: `犯规裁决：${cmd.against} 因 ${cmd.code} 受到 ${cmd.penalty}`,
      correlation_id: cmd.bout_id,
      payload: {
        bout_id: cmd.bout_id,
        round: cmd.round,
        referee_id: cmd.referee_id,
        against: cmd.against,
        code: cmd.code,
        penalty: cmd.penalty,
        deduction: cmd.deduction ?? 0,
        reason: cmd.reason,
      },
      actor: cmd.actor ?? { id: cmd.referee_id ?? "referee", role: "technical_official" },
    });
  }

  // ---------- 人工改判（引用原记录，不覆盖） ----------

  correctScore(cmd) {
    const bout = this._getBout(cmd.bout_id);
    const original = this.store.byId(cmd.correction_of);
    if (!original) fail("ORIGINAL_NOT_FOUND", "改判必须引用一条已存在的原始记录");
    if (original.payload?.bout_id && original.payload.bout_id !== cmd.bout_id) fail("ORIGINAL_NOT_FOUND", "被引用记录不属于该场比赛");
    if (original.event_type === "SCORE_CORRECTED") fail("CHAINED_CORRECTION", "改判只能引用原始记录；如需再改，请引用最初的原始事件");
    const already = bout.evidence.corrections.find((c) => c.correction_of === cmd.correction_of);
    if (already) fail("ALREADY_CORRECTED", `该记录已被 ${already.event_id} 改判`);

    let appeal = null;
    if (cmd.appeal_id) {
      appeal = this.state().appeals.get(cmd.appeal_id);
      if (!appeal || appeal.bout_id !== cmd.bout_id) fail("APPEAL_NOT_FOUND", "申诉不存在或不属于该场");
      if (!["filed", "under_review"].includes(appeal.status)) fail("APPEAL_CLOSED", `申诉已结束（${appeal.status}），不能再提交改判`);
      if (Date.parse(this.now()) > Date.parse(appeal.evidence_window_end)) {
        fail("APPEAL_EVIDENCE_WINDOW_CLOSED", `申诉证据窗口已于 ${appeal.evidence_window_end} 关闭`);
      }
    }

    // 已发布/锁定（含奥运资格赛）的结果不得事后随意改写，必须挂申诉。
    const result = this.state().results.get(cmd.bout_id);
    if (result?.effective && ["published", "locked"].includes(result.effective.stage) && !cmd.appeal_id) {
      fail("MUST_USE_APPEAL", "结果已正式发布；更正只能通过申诉流程引用原记录发起");
    }
    if (!["judge_score", "sensor_message", "foul"].includes(cmd.kind)) fail("BAD_CORRECTION_KIND", "未知改判类型");
    const role = cmd.actor?.role ?? (appeal ? "jury" : "head_judge");
    if (!appeal && role !== "head_judge" && role !== "jury") fail("FORBIDDEN", "只有裁判长/仲裁可以发起改判");

    const event = this._emit({
      event_type: "SCORE_CORRECTED",
      aggregate_type: "score_evidence",
      aggregate_id: cmd.correction_id ?? `correction-${cmd.correction_of}`,
      summary: `改判 ${cmd.correction_of}：${cmd.reason}`,
      correlation_id: cmd.bout_id,
      causation_id: cmd.correction_of,
      correction_of: cmd.correction_of,
      payload: {
        bout_id: cmd.bout_id,
        appeal_id: cmd.appeal_id ?? null,
        round: cmd.round ?? original.payload?.round,
        kind: cmd.kind,
        by: cmd.by ?? cmd.actor?.id,
        reason: cmd.reason,
        replacement: cmd.replacement,
      },
      actor: cmd.actor ?? { id: cmd.by ?? (appeal ? "jury" : "head-judge"), role },
    });

    // 自动计算只形成候选；正式名次仍待签署。挂申诉的候选为复核专用，不影响生效版本。
    this._projectCandidate(bout, { causationId: cmd.appeal_id ?? null });
    return event;
  }

  resolveTie(cmd) {
    const bout = this._getBout(cmd.bout_id);
    const candidate = buildCandidate(this.state(), bout);
    const group = candidate.unresolved_ties.find((g) => g.length === cmd.tied.length && g.every((id) => cmd.tied.includes(id)));
    if (!group) fail("NO_UNRESOLVED_TIE", "当前候选结果不存在该未决并列，裁决无的放矢");
    if (!cmd.tied.includes(cmd.winner)) fail("BAD_TIE_WINNER", "并列裁决的胜者必须出自并列各方");

    const event = this._emit({
      event_type: "TIEBREAK_RESOLVED",
      aggregate_type: "score_evidence",
      aggregate_id: `tiebreak-${cmd.bout_id}-${group.join("_")}`,
      summary: `并列裁决：${cmd.winner} 凭 ${cmd.basis} 胜出`,
      correlation_id: cmd.bout_id,
      payload: { bout_id: cmd.bout_id, round: cmd.round, tied: group, winner: cmd.winner, basis: cmd.basis, by: cmd.by ?? cmd.actor?.id },
      actor: cmd.actor ?? { id: "head-judge", role: "head_judge" },
    });
    this._projectCandidate(bout);
    return event;
  }

  // ---------- 候选 / 签署 / 发布 ----------

  projectCandidate(cmd) {
    const bout = this._getBout(cmd.bout_id);
    return this._projectCandidate(bout);
  }

  certifyResult(cmd, opts = {}) {
    const bout = this._getBout(cmd.bout_id);
    const result = this._getResult(cmd.bout_id);
    if (!opts.allowFrozen) this._assertAdvancementOpen(bout);
    const stage = result.effective?.stage;
    if (stage === "locked" && !opts.allowLocked) fail("RESULT_LOCKED", "奥运资格赛结果已锁定；改写只能经申诉改判并重新签署");
    if ((stage === "certified" || stage === "published") && !opts.allowRecertify) fail("RESULT_ALREADY_CERTIFIED", "结果已签署；新版本需经改判重新计算");
    const candidate = result.pending?.candidate ?? buildCandidate(this.state(), bout);
    if (candidate.unresolved_ties.length > 0) fail("TIE_UNRESOLVED", "仍有未决并列，不得签署：" + JSON.stringify(candidate.unresolved_ties));

    const seal = this._sealFor(cmd.signers, { anyOfRoles: ["head_judge", "result_arbiter", "jury"], minSignatures: 1 });
    return this._emit({
      event_type: "RESULT_CERTIFIED",
      aggregate_type: "result",
      aggregate_id: `result-${bout.bout_id}`,
      summary: `签署认证 ${bout.bout_id} 比赛结果`,
      correlation_id: bout.bout_id,
      causation_id: result.pending?.candidate_event_id ?? null,
      payload: { bout_id: bout.bout_id, sport: bout.sport, candidate },
      actor: { id: "signer", role: "result_arbiter" },
    }, seal);
  }

  publishResult(cmd, opts = {}) {
    const bout = this._getBout(cmd.bout_id);
    const result = this._getResult(cmd.bout_id);
    if (!opts.allowFrozen) this._assertAdvancementOpen(bout);
    if (!result.effective || !["certified", "published", "locked"].includes(result.effective.stage)) {
      fail("RESULT_NOT_CERTIFIED", "只有已签署认证的结果才能公告发布");
    }

    const seal = this._sealFor(cmd.signers, { anyOfRoles: ["result_arbiter"], minSignatures: 1 });
    const candidate = result.effective.candidate;
    const versionNo = result.history.length + 1;
    const published = this._emit({
      event_type: "RESULT_PUBLISHED",
      aggregate_type: "result",
      aggregate_id: `result-${bout.bout_id}`,
      summary: `${bout.bout_id} 比赛结果正式公告（第 ${versionNo} 版）`,
      correlation_id: bout.bout_id,
      causation_id: result.effective.certified_event_id,
      payload: {
        bout_id: bout.bout_id,
        sport: bout.sport,
        olympic_qualification: bout.olympic_qualification,
        public_version: {
          version_no: versionNo,
          winner: candidate.winner,
          winner_athlete_id: candidate.winner_athlete_id,
          standings: candidate.standings ?? null,
          outcome: candidate.outcome ?? null,
          certified_event_id: result.effective.certified_event_id,
          basis_event_ids: candidate.basis_event_ids,
          basis_seq: result.effective.basis_seq,
        },
      },
      actor: { id: "signer", role: "result_arbiter" },
    }, seal);

    // 冲浪承担奥运资格赛：公告即锁定，事后只能走申诉改判并产生新版本。
    if (bout.olympic_qualification) {
      const lockSeal = this._sealFor(cmd.signers, { anyOfRoles: ["result_arbiter"], minSignatures: 1 });
      this._emit({
        event_type: "RESULT_LOCKED",
        aggregate_type: "result",
        aggregate_id: `result-${bout.bout_id}`,
        summary: `${bout.bout_id} 为奥运资格赛，结果公告后锁定`,
        correlation_id: bout.bout_id,
        causation_id: published.event_id,
        payload: { bout_id: bout.bout_id, reason: "olympic_qualification" },
        actor: { id: "signer", role: "result_arbiter" },
      }, lockSeal);
    }
    return published;
  }

  // ---------- 晋级 ----------

  projectAdvancement(cmd) {
    const bout = this._getBout(cmd.source_bout_id);
    const result = this.state().results.get(bout.bout_id);
    if (!result) fail("RESULT_NOT_FOUND", "源场次尚无结果，无法投影晋级");
    const standings = (result.effective ?? result.pending)?.candidate?.standings;
    if (!standings) fail("NO_STANDINGS", "该赛项结果没有名次榜，无法按名次晋级");
    const slots = cmd.qualifying_positions.map((q) => {
      const row = standings.find((r) => r.rank === q.rank);
      if (!row) fail("BAD_QUALIFYING_RANK", `名次 ${q.rank} 不存在`);
      return { slot: q.slot ?? `P${q.rank}`, rank: q.rank, athlete_id: row.athlete_id, target_bout_id: q.target_bout_id ?? null };
    });
    return this._emit({
      event_type: "ADVANCEMENT_PROJECTED",
      aggregate_type: "advancement_chain",
      aggregate_id: cmd.chain_id,
      summary: `晋级链 ${cmd.chain_id} 投影：${bout.bout_id} 出线 ${slots.map((s) => s.athlete_id).join("、")}`,
      correlation_id: bout.bout_id,
      payload: {
        source_bout_id: bout.bout_id,
        slots,
        basis_result_event_id: result.effective?.certified_event_id ?? result.pending?.candidate_event_id,
      },
      actor: { id: "ruling-engine", role: "system" },
    });
  }

  confirmAdvancement(cmd) {
    const chain = this.state().chains.get(cmd.chain_id);
    if (!chain) fail("CHAIN_NOT_FOUND", `晋级链不存在：${cmd.chain_id}`);
    if (chain.frozen) {
      fail("CHAIN_FROZEN", `晋级链冻结中，待申诉处理：${chain.frozen_by.map((f) => f.appeal_id).join("、")}`);
    }
    const projection = chain.projections.get(cmd.source_bout_id);
    if (!projection) fail("ADVANCEMENT_NOT_PROJECTED", "不能确认尚未投影的晋级");
    const bout = this._getBout(cmd.source_bout_id);
    const result = this._getResult(cmd.source_bout_id);
    if (!result.effective || !["certified", "published", "locked"].includes(result.effective.stage)) {
      fail("RESULT_NOT_CERTIFIED", "源场次结果未经签署认证，晋级不得确认");
    }
    const seal = this._sealFor(cmd.signers, { anyOfRoles: ["result_arbiter", "technical_official"], minSignatures: 1 });
    return this._emit({
      event_type: "ADVANCEMENT_CONFIRMED",
      aggregate_type: "advancement_chain",
      aggregate_id: cmd.chain_id,
      summary: `确认 ${bout.bout_id} 出线人选进入后续轮次`,
      correlation_id: bout.bout_id,
      causation_id: projection.event_id,
      payload: { source_bout_id: bout.bout_id, slots: projection.slots },
      actor: { id: "signer", role: "result_arbiter" },
    }, seal);
  }

  _affectedBoutClosure(chainId, sourceBoutId) {
    const chain = this.state().chains.get(chainId);
    const affected = new Set([sourceBoutId]);
    const queue = [sourceBoutId];
    while (queue.length > 0) {
      const current = queue.shift();
      const targets = (chain?.projections.get(current)?.slots ?? []).map((s) => s.target_bout_id).filter(Boolean);
      for (const target of targets) {
        if (!affected.has(target)) {
          affected.add(target);
          queue.push(target);
        }
      }
    }
    return [...affected];
  }

  _freezeChain(chainId, sourceBoutId, appealId) {
    const boutIds = this._affectedBoutClosure(chainId, sourceBoutId);
    return this._emit({
      event_type: "ADVANCEMENT_FROZEN",
      aggregate_type: "advancement_chain",
      aggregate_id: chainId,
      summary: `申诉 ${appealId} 冻结晋级链受影响闭包：${boutIds.join("、")}；其余场次照常`,
      correlation_id: sourceBoutId,
      payload: { appeal_id: appealId, source_bout_id: sourceBoutId, bout_ids: boutIds },
      actor: { id: "appeal-desk", role: "service" },
    });
  }

  _unfreezeChain(chainId, appealId) {
    return this._emit({
      event_type: "ADVANCEMENT_UNFROZEN",
      aggregate_type: "advancement_chain",
      aggregate_id: chainId,
      summary: `申诉 ${appealId} 处理完毕，解除晋级链冻结`,
      payload: { appeal_id: appealId },
      actor: { id: "appeal-desk", role: "service" },
    });
  }

  // ---------- 申诉 ----------

  fileAppeal(cmd) {
    const bout = this._getBout(cmd.bout_id);
    const against = this.store.byId(cmd.against_event_id);
    if (!against || (against.correlation_id && against.correlation_id !== cmd.bout_id)) {
      fail("ORIGINAL_NOT_FOUND", "申诉必须引用本场一条真实记录");
    }
    if (this.state().appeals.has(cmd.appeal_id)) fail("APPEAL_EXISTS", `申诉已存在：${cmd.appeal_id}`);

    const rule = activeRuleAt(this.state(), bout.sport, this.now());
    const appealMinutes = rule?.windows?.appeal_minutes;
    const result = this.state().results.get(cmd.bout_id);
    const anchor = result?.effective?.published_at ?? against.occurred_at;
    if (appealMinutes !== undefined && Date.parse(this.now()) > Date.parse(anchor) + appealMinutes * 60_000) {
      fail("APPEAL_WINDOW_CLOSED", `申诉受理窗口已关闭（锚点 ${anchor} 起 ${appealMinutes} 分钟）`);
    }
    const evidenceMinutes = rule?.windows?.evidence_minutes ?? 60;
    const reviewMinutes = rule?.windows?.review_minutes ?? 120;
    const filedAt = this.now();

    this._emit({
      event_type: "APPEAL_FILED",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      summary: `代表队 ${cmd.delegation ?? cmd.filed_by} 就 ${cmd.bout_id} 提出申诉`,
      correlation_id: cmd.bout_id,
      causation_id: cmd.against_event_id,
      payload: {
        bout_id: cmd.bout_id,
        against_event_id: cmd.against_event_id,
        filed_by: cmd.filed_by,
        delegation: cmd.delegation,
        grounds: cmd.grounds,
        evidence_window_end: new Date(Date.parse(filedAt) + evidenceMinutes * 60_000).toISOString(),
        review_window_end: new Date(Date.parse(filedAt) + reviewMinutes * 60_000).toISOString(),
      },
      actor: cmd.actor ?? { id: cmd.filed_by, role: "delegation" },
    });
    this._freezeChain(bout.chain_id ?? `chain-${cmd.bout_id}`, cmd.bout_id, cmd.appeal_id);
    return this.state().appeals.get(cmd.appeal_id);
  }

  submitAppealEvidence(cmd) {
    const appeal = this.state().appeals.get(cmd.appeal_id);
    if (!appeal) fail("APPEAL_NOT_FOUND", `申诉不存在：${cmd.appeal_id}`);
    if (!["filed", "under_review"].includes(appeal.status)) fail("APPEAL_CLOSED", "申诉已结束");
    if (Date.parse(this.now()) > Date.parse(appeal.evidence_window_end)) {
      fail("APPEAL_EVIDENCE_WINDOW_CLOSED", `证据窗口已于 ${appeal.evidence_window_end} 关闭`);
    }
    return this._emit({
      event_type: "APPEAL_EVIDENCE_ACCEPTED",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      summary: `接收申诉证据：${cmd.kind}`,
      correlation_id: appeal.bout_id,
      payload: { kind: cmd.kind, ref: cmd.ref, hash: cmd.hash, submitted_by: cmd.submitted_by },
      actor: cmd.actor ?? { id: cmd.submitted_by ?? appeal.filed_by, role: "delegation" },
    });
  }

  logReview(cmd) {
    const appeal = this.state().appeals.get(cmd.appeal_id);
    if (!appeal) fail("APPEAL_NOT_FOUND", `申诉不存在：${cmd.appeal_id}`);
    if (!["filed", "under_review"].includes(appeal.status)) fail("APPEAL_CLOSED", "申诉已结束");
    if (Date.parse(this.now()) > Date.parse(appeal.review_window_end)) {
      fail("REVIEW_WINDOW_CLOSED", `复核意见窗口已于 ${appeal.review_window_end} 关闭`);
    }
    return this._emit({
      event_type: "APPEAL_REVIEW_LOGGED",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      summary: `仲裁复核意见：${cmd.recommendation}`,
      correlation_id: appeal.bout_id,
      payload: { by: cmd.by, recommendation: cmd.recommendation, note: cmd.note },
      actor: cmd.actor ?? { id: cmd.by ?? "jury", role: "jury" },
    });
  }

  decideAppeal(cmd) {
    const appeal = this.state().appeals.get(cmd.appeal_id);
    if (!appeal) fail("APPEAL_NOT_FOUND", `申诉不存在：${cmd.appeal_id}`);
    if (!["filed", "under_review"].includes(appeal.status)) fail("APPEAL_CLOSED", "申诉已结束");
    if (Date.parse(this.now()) > Date.parse(appeal.review_window_end)) {
      fail("REVIEW_WINDOW_CLOSED", `复核裁决窗口已于 ${appeal.review_window_end} 关闭`);
    }
    const bout = this._getBout(appeal.bout_id);

    if (cmd.outcome === "rejected") {
      this._emit({
        event_type: "APPEAL_REJECTED",
        aggregate_type: "appeal_case",
        aggregate_id: cmd.appeal_id,
        summary: `申诉驳回：${cmd.reason}`,
        correlation_id: appeal.bout_id,
        payload: { reason: cmd.reason },
        actor: cmd.actor ?? { id: "jury", role: "jury" },
      }, this._sealFor(cmd.signers, { anyOfRoles: ["jury", "head_judge"], minSignatures: 1 }));
      this._unfreezeChain(bout.chain_id ?? `chain-${appeal.bout_id}`, cmd.appeal_id);
      return this.state().appeals.get(cmd.appeal_id);
    }

    if (cmd.outcome !== "upheld") fail("BAD_APPEAL_OUTCOME", "outcome 必须是 upheld 或 rejected");

    // 支持申诉：必须有挂在本申诉下的改判（directive=amend），或明确 reaffirm/order_replay。
    const corrections = bout.evidence.corrections.filter((c) => c.appeal_id === cmd.appeal_id);
    const directive = cmd.directive ?? (corrections.length > 0 ? "amend" : "reaffirm");
    if (directive === "amend" && corrections.length === 0) fail("NO_AMENDMENT", "改判指令缺少挂接的 SCORE_CORRECTED 记录");

    // 申诉成立本身需要仲裁签署；改判重发还需成绩签署人（publish_signers）共同授权。
    // 两类授权都必须在追加任何事件前预检通过，避免「申诉已结束却发不出新版本」的半成品状态。
    const jurySeal = this._sealFor(cmd.signers, { anyOfRoles: ["jury", "head_judge"], minSignatures: 1 });
    if (directive === "amend") {
      this._sealFor(cmd.publish_signers ?? cmd.signers, { anyOfRoles: ["result_arbiter"], minSignatures: 1 });
    }
    const upheld = this._emit({
      event_type: "APPEAL_UPHELD",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      summary: `申诉成立：${directive === "amend" ? "授权按改判重新计算并重新签署发布" : directive}`,
      correlation_id: appeal.bout_id,
      payload: { directive, correction_event_ids: corrections.map((c) => c.event_id) },
      actor: { id: "jury", role: "jury" },
    }, jurySeal);

    if (directive === "amend") {
      // 改判期间原公告版本始终生效；直到新版本签署公告成功，公开视图才切换。
      this._projectCandidate(bout, { causationId: upheld.event_id });
      // allowLocked 是申诉授权改写奥运资格赛锁定结果的唯一路径；旧版本进入 history 而非删除。
      this.certifyResult(
        { bout_id: bout.bout_id, signers: cmd.publish_signers ?? cmd.signers },
        { allowFrozen: true, allowLocked: true, allowRecertify: true },
      );
      this.publishResult({ bout_id: bout.bout_id, signers: cmd.publish_signers ?? cmd.signers }, { allowFrozen: true });
    }

    this._unfreezeChain(bout.chain_id ?? `chain-${appeal.bout_id}`, cmd.appeal_id);
    return this.state().appeals.get(cmd.appeal_id);
  }

  withdrawAppeal(cmd) {
    const appeal = this.state().appeals.get(cmd.appeal_id);
    if (!appeal) fail("APPEAL_NOT_FOUND", `申诉不存在：${cmd.appeal_id}`);
    if (!["filed", "under_review"].includes(appeal.status)) fail("APPEAL_CLOSED", "申诉已结束，不能撤回");
    if (cmd.by && cmd.by !== appeal.filed_by) fail("FORBIDDEN", "只有申诉方可以撤回");
    this._emit({
      event_type: "APPEAL_WITHDRAWN",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      summary: "申诉撤回",
      correlation_id: appeal.bout_id,
      payload: {},
      actor: { id: cmd.by ?? appeal.filed_by, role: "delegation" },
    });
    this._unfreezeChain(this.state().bouts.get(appeal.bout_id).chain_id ?? `chain-${appeal.bout_id}`, cmd.appeal_id);
    return this.state().appeals.get(cmd.appeal_id);
  }

  // ---------- 纪录认证 ----------

  certifyRecord(cmd) {
    const bout = this.state().bouts.get(cmd.bout_id);
    if (!bout) fail("BOUT_NOT_FOUND", `纪录来源比赛不存在：${cmd.bout_id}`);
    const result = this.state().results.get(cmd.bout_id)?.effective;
    if (!result || !["certified", "published", "locked"].includes(result.stage)) {
      fail("RESULT_NOT_CERTIFIED", "纪录只能在比赛结果正式签署后认证");
    }
    if (!cmd.mark || typeof cmd.mark.value !== "number") fail("BAD_RECORD_MARK", "纪录成绩必须包含数值 mark.value");
    const seal = this._sealFor(cmd.signers, { allOfRoles: ["chief_recorder", "head_judge"], minSignatures: 2 });
    return this._emit({
      event_type: "RECORD_CERTIFIED",
      aggregate_type: "record",
      aggregate_id: cmd.record_id,
      summary: `认证纪录：${cmd.athlete_id} 在 ${cmd.sport}${cmd.category ? `（${cmd.category}）` : ""} 创造 ${cmd.mark.value}`,
      correlation_id: cmd.bout_id,
      causation_id: result.certified_event_id,
      payload: {
        record_id: cmd.record_id,
        athlete_id: cmd.athlete_id,
        sport: cmd.sport,
        category: cmd.category,
        mark: cmd.mark,
        bout_id: cmd.bout_id,
        basis_event_ids: cmd.basis_event_ids ?? result.candidate.basis_event_ids,
      },
      actor: { id: "records-office", role: "chief_recorder" },
    }, seal);
  }

  /** 存储底层（供投影/重放查询）。 */
  events() {
    return this.store.all();
  }
}

function hashString(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return h;
}
