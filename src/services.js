import { randomUUID } from "node:crypto";
import { makeEvent, nowIso } from "./envelope.js";
import {
  acceptedEvidence,
  activePenalties,
  calibrationValidAt,
  downstreamBouts,
  fold,
  judgeConflict,
} from "./projection.js";
import { compute } from "./scoring.js";

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ROLES = {
  certify: ["jury_president", "chief_referee", "technical_delegate"],
  publish: ["jury_president", "technical_delegate"],
  referee: ["referee", "chief_referee"],
  review: ["jury_president", "chief_referee", "technical_delegate", "review_panel"],
  record: ["record_committee"],
};

const uid = (prefix) => `${prefix}_${randomUUID().slice(0, 12)}`;
const addMinutes = (iso, minutes) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

/** 领域服务：所有写操作都翻译为仅追加事件。 */
export class RulingService {
  /** @param {import("./store.js").EventStore} store */
  constructor(store) {
    this.store = store;
  }

  get state() {
    return fold(this.store.all());
  }

  // ---------- 内部工具 ----------

  _append(fields, options = {}) {
    const event = makeEvent({
      ...(options.idempotencyKey !== undefined && { idempotency_key: options.idempotencyKey }),
      version: this.store.versionOf(fields.aggregate_id) + 1,
      occurred_at: options.at ?? nowIso(),
      ...fields,
    });
    return this.store.append(event, {
      expectedVersion: event.version - 1,
      idempotencyKey: options.idempotencyKey,
    }).event;
  }

  _getBout(boutId) {
    const bout = this.state.bouts.get(boutId);
    if (!bout) throw new DomainError("BOUT_NOT_FOUND", `场次不存在：${boutId}`);
    return bout;
  }

  _activeRulebook(sport) {
    const books = [...this.state.rulebooks.values()].filter(
      (b) => b.sport === sport && b.status === "active",
    );
    if (books.length === 0) throw new DomainError("NO_ACTIVE_RULEBOOK", `赛项 ${sport} 没有生效中的规则版本`);
    return books[0];
  }

  _assertRole(officialId, action) {
    const official = this.state.officials.get(officialId);
    if (!official) throw new DomainError("OFFICIAL_NOT_FOUND", `裁判/官员未登记：${officialId}`);
    const roles = official.roles ?? [official.role];
    if (!roles.some((r) => ROLES[action].includes(r))) {
      throw new DomainError("FORBIDDEN", `${officialId} 角色 ${roles.join("/")} 无权执行 ${action}`);
    }
    return official;
  }

  _assertNotFrozen(boutId) {
    const appealId = this.state.frozenBouts.get(boutId);
    if (appealId) {
      throw new DomainError(
        "ADVANCEMENT_FROZEN",
        `场次 ${boutId} 的晋级链因申诉 ${appealId} 冻结，本操作暂缓`,
      );
    }
  }

  _windowOpen(bout, kind, at = nowIso()) {
    if (bout.status !== "ended") return true;
    const deadline = kind === "appeal" ? bout.appeal_deadline : bout.evidence_deadline;
    return deadline === undefined || new Date(at) <= new Date(deadline);
  }

  // ---------- 规则版本 ----------

  publishRulebook(cmd) {
    const id = cmd.rulebook_id ?? `rule-${cmd.sport}-${cmd.rules_version.replaceAll(".", "-")}`;
    if (this.state.rulebooks.has(id)) throw new DomainError("RULEBOOK_EXISTS", `规则版本已存在：${id}`);
    return this._append({
      event_type: "RULEBOOK_PUBLISHED",
      aggregate_type: "rulebook",
      aggregate_id: id,
      summary: `发布 ${cmd.sport} 规则 ${cmd.rules_version}`,
      payload: {
        sport: cmd.sport,
        rules_version: cmd.rules_version,
        effective_from: cmd.effective_from,
        config: cmd.config ?? {},
      },
    });
  }

  activateRulebook(cmd) {
    if (!this.state.rulebooks.has(cmd.rulebook_id)) {
      throw new DomainError("RULEBOOK_NOT_FOUND", `规则版本不存在：${cmd.rulebook_id}`);
    }
    return this._append({
      event_type: "RULEBOOK_ACTIVATED",
      aggregate_type: "rulebook",
      aggregate_id: cmd.rulebook_id,
      summary: `激活规则版本 ${cmd.rulebook_id}`,
      payload: { sport: cmd.sport },
    });
  }

  // ---------- 运动员与资格 ----------

  registerAthlete(cmd) {
    if (this.state.athletes.has(cmd.athlete_id)) {
      throw new DomainError("ATHLETE_EXISTS", `运动员已登记：${cmd.athlete_id}`);
    }
    return this._append({
      event_type: "ATHLETE_REGISTERED",
      aggregate_type: "athlete",
      aggregate_id: cmd.athlete_id,
      summary: `登记运动员 ${cmd.name ?? cmd.athlete_id}`,
      payload: { name: cmd.name, team_id: cmd.team_id, npc: cmd.npc },
    });
  }

  grantEligibility(cmd) {
    const id = `elig-${cmd.athlete_id}-${cmd.competition_id}`;
    return this._append({
      event_type: "ELIGIBILITY_GRANTED",
      aggregate_type: "eligibility",
      aggregate_id: id,
      summary: `授予 ${cmd.athlete_id} 参赛资格`,
      payload: {
        athlete_id: cmd.athlete_id,
        competition_id: cmd.competition_id,
        reason: cmd.reason,
        olympic_path: cmd.olympic_path ?? false,
      },
    });
  }

  revokeEligibility(cmd) {
    const id = `elig-${cmd.athlete_id}-${cmd.competition_id}`;
    if (this.store.versionOf(id) === 0) {
      throw new DomainError("ELIGIBILITY_NOT_FOUND", `资格记录不存在：${id}`);
    }
    return this._append({
      event_type: "ELIGIBILITY_REVOKED",
      aggregate_type: "eligibility",
      aggregate_id: id,
      summary: `撤销 ${cmd.athlete_id} 参赛资格：${cmd.reason}`,
      payload: { athlete_id: cmd.athlete_id, competition_id: cmd.competition_id, reason: cmd.reason },
    });
  }

  // ---------- 裁判、回避与指派 ----------

  registerOfficial(cmd) {
    return this._append({
      event_type: "OFFICIAL_REGISTERED",
      aggregate_type: "official",
      aggregate_id: cmd.official_id,
      summary: `登记官员 ${cmd.name ?? cmd.official_id}`,
      payload: { name: cmd.name, roles: cmd.roles ?? [cmd.role ?? "judge"] },
    });
  }

  declareConflict(cmd) {
    return this._append({
      event_type: "CONFLICT_DECLARED",
      aggregate_type: "official",
      aggregate_id: cmd.official_id,
      summary: `裁判 ${cmd.official_id} 声明回避：${cmd.reason}`,
      payload: {
        official_id: cmd.official_id,
        conflict_type: cmd.conflict_type,
        ref_id: cmd.ref_id,
        reason: cmd.reason,
      },
    });
  }

  assignPanel(cmd) {
    const bout = this._getBout(cmd.bout_id);
    for (const seat of cmd.seats) {
      const check = judgeConflict(this.state, seat.official_id, bout);
      if (check.conflict) {
        throw new DomainError(
          "JUDGE_CONFLICT",
          `裁判 ${seat.official_id} 与场次 ${cmd.bout_id} 存在利益冲突（${check.reason}），应予回避`,
        );
      }
    }
    return this._append({
      event_type: "PANEL_ASSIGNED",
      aggregate_type: "panel",
      aggregate_id: `panel-${cmd.bout_id}`,
      correlation_id: cmd.bout_id,
      summary: `为 ${cmd.bout_id} 指派 ${cmd.seats.length} 名裁判官员`,
      payload: { bout_id: cmd.bout_id, seats: cmd.seats },
    });
  }

  replaceJudge(cmd) {
    this._getBout(cmd.bout_id);
    return this._append({
      event_type: "JUDGE_REPLACED",
      aggregate_type: "panel",
      aggregate_id: `panel-${cmd.bout_id}`,
      correlation_id: cmd.bout_id,
      summary: `更换 ${cmd.bout_id} 的 ${cmd.role}：${cmd.replacement_id}`,
      payload: cmd,
    });
  }

  // ---------- 设备注册、校准与绑定 ----------

  registerDevice(cmd) {
    return this._append({
      event_type: "DEVICE_REGISTERED",
      aggregate_type: "device",
      aggregate_id: cmd.device_id,
      summary: `登记设备 ${cmd.device_id}（${cmd.device_type}）`,
      payload: { device_type: cmd.device_type, model: cmd.model },
    });
  }

  calibrateDevice(cmd) {
    if (!this.state.devices.has(cmd.device_id)) {
      throw new DomainError("DEVICE_NOT_FOUND", `设备未登记：${cmd.device_id}`);
    }
    return this._append({
      event_type: "DEVICE_CALIBRATED",
      aggregate_type: "device",
      aggregate_id: cmd.device_id,
      summary: `设备 ${cmd.device_id} 校准${cmd.result === "pass" ? "通过" : "未通过"}`,
      payload: {
        result: cmd.result,
        tolerance: cmd.tolerance,
        valid_until: cmd.valid_until,
        certifier_id: cmd.certifier_id,
      },
    });
  }

  bindDevice(cmd) {
    this._getBout(cmd.bout_id);
    return this._append({
      event_type: "DEVICE_BOUND",
      aggregate_type: "device",
      aggregate_id: cmd.device_id,
      correlation_id: cmd.bout_id,
      summary: `设备 ${cmd.device_id} 绑定场次 ${cmd.bout_id}`,
      payload: { device_id: cmd.device_id, bout_id: cmd.bout_id },
    });
  }

  // ---------- 赛程、抽签与场次 ----------

  scheduleSession(cmd) {
    return this._append({
      event_type: "SESSION_SCHEDULED",
      aggregate_type: "session",
      aggregate_id: cmd.session_id,
      summary: `编排比赛单元 ${cmd.session_id}`,
      payload: { name: cmd.name, starts_at: cmd.starts_at, sport: cmd.sport },
    });
  }

  conductDraw(cmd) {
    return this._append({
      event_type: "DRAW_CONDUCTED",
      aggregate_type: "draw",
      aggregate_id: cmd.draw_id,
      summary: `完成 ${cmd.sport} 抽签 ${cmd.draw_id}`,
      payload: {
        session_id: cmd.session_id,
        sport: cmd.sport,
        bracket: cmd.bracket,
        seed_method: cmd.seed_method ?? "random",
      },
    });
  }

  publishDraw(cmd) {
    if (!this.state.draws.has(cmd.draw_id)) throw new DomainError("DRAW_NOT_FOUND", cmd.draw_id);
    return this._append({
      event_type: "DRAW_PUBLISHED",
      aggregate_type: "draw",
      aggregate_id: cmd.draw_id,
      summary: `公布抽签结果 ${cmd.draw_id}`,
      payload: {},
    });
  }

  scheduleBout(cmd) {
    const rulebook = this._activeRulebook(cmd.sport);
    return this._append({
      event_type: "BOUT_SCHEDULED",
      aggregate_type: "bout",
      aggregate_id: cmd.bout_id,
      correlation_id: cmd.bout_id,
      summary: `编排场次 ${cmd.bout_id}（${cmd.round_label}）`,
      payload: {
        sport: cmd.sport,
        rulebook_id: rulebook.id,
        rules_version: rulebook.rules_version,
        session_id: cmd.session_id,
        draw_id: cmd.draw_id,
        round_label: cmd.round_label,
        entries: cmd.entries ?? [],
        scheduled_at: cmd.scheduled_at,
      },
    });
  }

  qualifyParticipant(cmd) {
    const bout = this._getBout(cmd.bout_id);
    const eligibility = this.state.eligibility.get(`${cmd.athlete_id}:${cmd.competition_id}`);
    if (!eligibility || eligibility.status !== "eligible") {
      throw new DomainError("NOT_ELIGIBLE", `运动员 ${cmd.athlete_id} 不具备有效参赛资格`);
    }
    return this._append({
      event_type: "BOUT_PARTICIPANT_QUALIFIED",
      aggregate_type: "bout",
      aggregate_id: cmd.bout_id,
      correlation_id: cmd.bout_id,
      summary: `${cmd.athlete_id} 取得 ${cmd.bout_id} 出场资格（来源：${cmd.source_bout_id ?? "抽签"}）`,
      payload: cmd,
    });
  }

  startRound(cmd) {
    this._getBout(cmd.bout_id);
    return this._append({
      event_type: "ROUND_STARTED",
      aggregate_type: "bout",
      aggregate_id: cmd.bout_id,
      correlation_id: cmd.bout_id,
      summary: `${cmd.bout_id} 第 ${cmd.round_no} 轮开始`,
      payload: { bout_id: cmd.bout_id, round_no: cmd.round_no },
    });
  }

  endRound(cmd) {
    return this._append({
      event_type: "ROUND_ENDED",
      aggregate_type: "bout",
      aggregate_id: cmd.bout_id,
      correlation_id: cmd.bout_id,
      summary: `${cmd.bout_id} 第 ${cmd.round_no} 轮结束`,
      payload: { bout_id: cmd.bout_id, round_no: cmd.round_no },
    });
  }

  endBout(cmd) {
    const bout = this._getBout(cmd.bout_id);
    const rulebook = this.state.rulebooks.get(bout.rulebook_id);
    const windows = rulebook?.config ?? {};
    const at = cmd.at ?? nowIso();
    return this._append(
      {
        event_type: "BOUT_ENDED",
        aggregate_type: "bout",
        aggregate_id: cmd.bout_id,
        correlation_id: cmd.bout_id,
        summary: `${cmd.bout_id} 比赛结束`,
        payload: {
          bout_id: cmd.bout_id,
          evidence_deadline: addMinutes(at, windows.evidence_window_minutes ?? 30),
          appeal_deadline: addMinutes(at, windows.appeal_window_minutes ?? 15),
        },
      },
      { at },
    );
  }

  // ---------- 证据摄取（离线补传、去重、乱序、校准隔离） ----------

  /**
   * @param {object} cmd
   * @param {string} cmd.bout_id
   * @param {"wave_judge_score"|"round_scorecard"|"bout_outcome"|"sensor_hit"|"judge_art_score"} cmd.kind
   * @param {object} cmd.data 评分/传感器字段
   * @param {string} [cmd.judge_id]
   * @param {string} [cmd.device_id]
   * @param {string} [cmd.occurred_at] 设备/裁判事实时间，可早于接收时间（离线补传）
   * @param {string} [cmd.idempotency_key] 设备侧去重键
   */
  recordEvidence(cmd) {
    const bout = this._getBout(cmd.bout_id);
    const at = cmd.occurred_at ?? nowIso();
    if (!this._windowOpen(bout, "evidence", cmd.received_at ?? nowIso())) {
      throw new DomainError(
        "EVIDENCE_WINDOW_CLOSED",
        `场次 ${cmd.bout_id} 证据窗口已于 ${bout.evidence_deadline} 关闭`,
      );
    }

    let quarantineReason;
    if (cmd.device_id) {
      const device = this.state.devices.get(cmd.device_id);
      if (!device) quarantineReason = "设备未登记";
      else if (device.bound?.bout_id !== cmd.bout_id) quarantineReason = "设备未绑定本场";
      else if (!calibrationValidAt(device, at)) quarantineReason = "事实时间不在有效校准期内";
    }
    if (cmd.judge_id) {
      const seat = (this.state.panels.get(cmd.bout_id) ?? []).find(
        (s) => s.official_id === cmd.judge_id && s.status === "active",
      );
      if (!seat) quarantineReason ??= `裁判 ${cmd.judge_id} 不在本场现行裁判组`;
    }

    const evidenceId = cmd.evidence_id ?? uid("evi");
    const base = {
      aggregate_type: "evidence",
      aggregate_id: evidenceId,
      correlation_id: cmd.bout_id,
      payload: {
        bout_id: cmd.bout_id,
        kind: cmd.kind,
        occurred_at: at,
        judge_id: cmd.judge_id,
        device_id: cmd.device_id,
        ...cmd.data,
      },
    };
    const append = (fields) =>
      this.store.append(
        makeEvent({
          ...(cmd.idempotency_key !== undefined && { idempotency_key: cmd.idempotency_key }),
          version: this.store.versionOf(fields.aggregate_id) + 1,
          occurred_at: cmd.received_at ?? nowIso(),
          ...fields,
        }),
        {
          expectedVersion: this.store.versionOf(fields.aggregate_id),
          ...(cmd.idempotency_key !== undefined && { idempotencyKey: cmd.idempotency_key }),
        },
      );
    const result = quarantineReason
      ? append({
          ...base,
          event_type: "EVIDENCE_QUARANTINED",
          summary: `隔离 ${cmd.kind} 证据：${quarantineReason}`,
          payload: { ...base.payload, reason: quarantineReason },
        })
      : append({
          ...base,
          event_type: "EVIDENCE_RECORDED",
          summary: `记录 ${cmd.kind} 证据（事实时间 ${at}）`,
        });
    return {
      status: result.status,
      event: result.event,
      quarantined: result.event.event_type === "EVIDENCE_QUARANTINED",
      reason: quarantineReason,
    };
  }

  // ---------- 处罚 ----------

  imposePenalty(cmd) {
    const bout = this._getBout(cmd.bout_id);
    if (cmd.official_id) this._assertRole(cmd.official_id, "referee");
    if (bout.olympic_locked) {
      throw new DomainError(
        "OLYMPIC_LOCKED",
        `场次 ${cmd.bout_id} 结果已用于奥运资格分配，证据链锁定，不得追加判罚`,
      );
    }
    if (!bout.entries.includes(cmd.athlete_id)) {
      throw new DomainError("NOT_PARTICIPANT", `${cmd.athlete_id} 不在 ${cmd.bout_id} 名单内`);
    }
    const id = uid("san");
    return this._append({
      event_type: "PENALTY_IMPOSED",
      aggregate_type: "sanction",
      aggregate_id: id,
      correlation_id: cmd.bout_id,
      summary: `${cmd.bout_id} 对 ${cmd.athlete_id} 判罚 ${cmd.kind}：${cmd.reason}`,
      payload: {
        bout_id: cmd.bout_id,
        athlete_id: cmd.athlete_id,
        kind: cmd.kind,
        deduction_points: cmd.deduction_points,
        points: cmd.points,
        round_no: cmd.round_no,
        judge_id: cmd.official_id,
        // 台上裁判的扣分对全体裁判记分卡生效；裁判个人更正可显式指定 applies_to
        applies_to: cmd.applies_to ?? (cmd.deduction_points ? "all_judges" : undefined),
        reason: cmd.reason,
      },
    });
  }

  revokePenalty(cmd) {
    const sanction = this.state.sanctions.get(cmd.sanction_id);
    if (!sanction) throw new DomainError("SANCTION_NOT_FOUND", cmd.sanction_id);
    return this._append({
      event_type: "PENALTY_REVOKED",
      aggregate_type: "sanction",
      aggregate_id: cmd.sanction_id,
      correlation_id: sanction.bout_id,
      summary: `撤销判罚 ${cmd.sanction_id}：${cmd.reason}`,
      payload: { sanction_id: cmd.sanction_id, reason: cmd.reason, revoked_by: cmd.official_id },
    });
  }

  // ---------- 人工改判：必须引用原记录 ----------

  amendRuling(cmd) {
    const state = this.state;
    const target = state.evidence.get(cmd.target_id) ?? state.sanctions.get(cmd.target_id);
    if (!target) throw new DomainError("TARGET_NOT_FOUND", `原记录不存在：${cmd.target_id}`);
    if (target.status === "voided") {
      throw new DomainError("TARGET_VOIDED", `原记录 ${cmd.target_id} 已作废，不能再次改判`);
    }
    if (target.status === "superseded") {
      throw new DomainError(
        "TARGET_NOT_CURRENT",
        `原记录 ${cmd.target_id} 已被 ${target.superseded_by} 取代；改判只能引用现行版本，不得层层覆盖`,
      );
    }
    const boutId = target.bout_id;
    const bout = state.bouts.get(boutId);
    if (bout?.olympic_locked) {
      throw new DomainError(
        "OLYMPIC_LOCKED",
        `场次 ${boutId} 结果已用于奥运资格分配，证据链锁定，不允许事后改写`,
      );
    }
    const openAppeal = [...state.appeals.values()].some(
      (a) => a.bout_id === boutId && ["filed", "in_review"].includes(a.status),
    );
    if (!openAppeal && !this._windowOpen(bout, "evidence", cmd.at ?? nowIso())) {
      throw new DomainError(
        "AMENDMENT_WINDOW_CLOSED",
        `场次 ${boutId} 证据窗口已关闭，改判需通过申诉复核程序`,
      );
    }
    if (cmd.action === "correct" && state.evidence.has(cmd.target_id) && !cmd.correction) {
      throw new DomainError("CORRECTION_REQUIRED", "correct 动作必须携带 correction 内容");
    }

    const id = uid("amd");
    return this._append({
      event_type: "RULING_AMENDED",
      aggregate_type: "evidence",
      aggregate_id: id,
      correlation_id: boutId,
      causation_id: cmd.causation_id ?? cmd.target_id,
      summary:
        cmd.action === "void"
          ? `作废原记录 ${cmd.target_id}：${cmd.reason}`
          : `更正原记录 ${cmd.target_id}：${cmd.reason}`,
      payload: {
        target_id: cmd.target_id,
        action: cmd.action,
        correction: cmd.correction,
        reason: cmd.reason,
        amended_by: cmd.official_id,
        appeal_id: cmd.appeal_id,
      },
    });
  }

  // ---------- 申诉：定向冻结晋级链 ----------

  fileAppeal(cmd) {
    const bout = this._getBout(cmd.bout_id);
    if (!this._windowOpen(bout, "appeal", cmd.at ?? nowIso())) {
      throw new DomainError(
        "APPEAL_WINDOW_CLOSED",
        `场次 ${cmd.bout_id} 申诉窗口已于 ${bout.appeal_deadline} 关闭`,
      );
    }
    const id = cmd.appeal_id ?? uid("apl");
    const affected = downstreamBouts(this.state, cmd.bout_id);
    this._append({
      event_type: "APPEAL_FILED",
      aggregate_type: "appeal_case",
      aggregate_id: id,
      correlation_id: cmd.bout_id,
      summary: `${cmd.filed_by} 就 ${cmd.bout_id} 提出申诉：${cmd.reason}`,
      payload: {
        bout_id: cmd.bout_id,
        filed_by: cmd.filed_by,
        reason: cmd.reason,
        affected_bout_ids: affected,
        appeal_deadline: bout.appeal_deadline,
      },
    });
    this._append({
      event_type: "ADVANCEMENT_FROZEN",
      aggregate_type: "progression",
      aggregate_id: `prog-${bout.draw_id ?? "standalone"}`,
      correlation_id: cmd.bout_id,
      causation_id: id,
      summary: `冻结 ${cmd.bout_id} 申诉影响的晋级链：${affected.join("、")}（其他场次照常推进）`,
      payload: { appeal_id: id, source_bout_id: cmd.bout_id, affected_bout_ids: affected },
    });
    return id;
  }

  addAppealEvidence(cmd) {
    const appeal = this.state.appeals.get(cmd.appeal_id);
    if (!appeal) throw new DomainError("APPEAL_NOT_FOUND", cmd.appeal_id);
    if (!["filed", "in_review"].includes(appeal.status)) {
      throw new DomainError("APPEAL_CLOSED", `申诉 ${cmd.appeal_id} 已${appeal.status}`);
    }
    const bout = this.state.bouts.get(appeal.bout_id);
    if (!this._windowOpen(bout, "evidence", cmd.at ?? nowIso()) && appeal.status !== "in_review") {
      throw new DomainError("EVIDENCE_WINDOW_CLOSED", "证据窗口已关闭");
    }
    return this._append({
      event_type: "APPEAL_EVIDENCE_ADDED",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      correlation_id: appeal.bout_id,
      summary: `申诉 ${cmd.appeal_id} 补充证据 ${cmd.evidence_event_id}`,
      payload: { evidence_event_id: cmd.evidence_event_id, note: cmd.note },
    });
  }

  openReview(cmd) {
    this._assertRole(cmd.official_id, "review");
    const appeal = this.state.appeals.get(cmd.appeal_id);
    if (!appeal || appeal.status !== "filed") {
      throw new DomainError("REVIEW_NOT_OPENABLE", `申诉 ${cmd.appeal_id} 当前不可受理`);
    }
    return this._append({
      event_type: "REVIEW_OPENED",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      correlation_id: appeal.bout_id,
      summary: `申诉 ${cmd.appeal_id} 进入复核`,
      payload: { opened_by: cmd.official_id },
    });
  }

  issueOpinion(cmd) {
    this._assertRole(cmd.official_id, "review");
    const appeal = this.state.appeals.get(cmd.appeal_id);
    if (!appeal || appeal.status !== "in_review") {
      throw new DomainError("REVIEW_NOT_OPEN", `申诉 ${cmd.appeal_id} 未在复核中`);
    }
    return this._append({
      event_type: "REVIEW_OPINION_ISSUED",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      correlation_id: appeal.bout_id,
      summary: `${cmd.official_id} 对申诉 ${cmd.appeal_id} 的复核意见：${cmd.recommendation}`,
      payload: {
        official_id: cmd.official_id,
        recommendation: cmd.recommendation,
        note: cmd.note,
      },
    });
  }

  decideAppeal(cmd) {
    this._assertRole(cmd.official_id, "review");
    const appeal = this.state.appeals.get(cmd.appeal_id);
    if (!appeal) throw new DomainError("APPEAL_NOT_FOUND", cmd.appeal_id);
    if (!["filed", "in_review"].includes(appeal.status)) {
      throw new DomainError("APPEAL_CLOSED", `申诉 ${cmd.appeal_id} 已${appeal.status}`);
    }
    if (cmd.decision === "upheld" && appeal.amendments.length === 0) {
      throw new DomainError(
        "AMENDMENT_REQUIRED",
        "申诉成立必须先以引用原记录的方式完成改判，再作决定",
      );
    }
    this._append({
      event_type: "APPEAL_DECIDED",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      correlation_id: appeal.bout_id,
      summary:
        cmd.decision === "upheld"
          ? `申诉 ${cmd.appeal_id} 成立，已改判并解冻晋级链`
          : `申诉 ${cmd.appeal_id} 被驳回，解冻晋级链`,
      payload: {
        decision: cmd.decision,
        note: cmd.note,
        decided_by: cmd.official_id,
      },
    });
    this._releaseFreeze(appeal, cmd.official_id);
  }

  /** 申诉方在裁决前撤回申诉：解冻晋级链。 */
  withdrawAppeal(cmd) {
    const appeal = this.state.appeals.get(cmd.appeal_id);
    if (!appeal) throw new DomainError("APPEAL_NOT_FOUND", cmd.appeal_id);
    if (!["filed", "in_review"].includes(appeal.status)) {
      throw new DomainError("APPEAL_CLOSED", `申诉 ${cmd.appeal_id} 已${appeal.status}`);
    }
    this._append({
      event_type: "APPEAL_WITHDRAWN",
      aggregate_type: "appeal_case",
      aggregate_id: cmd.appeal_id,
      correlation_id: appeal.bout_id,
      summary: `${cmd.filed_by ?? appeal.filed_by} 撤回申诉 ${cmd.appeal_id}`,
      payload: { reason: cmd.reason, withdrawn_by: cmd.filed_by },
    });
    this._releaseFreeze(appeal, cmd.filed_by);
  }

  _releaseFreeze(appeal, by) {
    const affected = downstreamBouts(this.state, appeal.bout_id);
    this._append({
      event_type: "ADVANCEMENT_RELEASED",
      aggregate_type: "progression",
      aggregate_id: `prog-${this.state.bouts.get(appeal.bout_id)?.draw_id ?? "standalone"}`,
      correlation_id: appeal.bout_id,
      causation_id: appeal.id,
      summary: `申诉 ${appeal.id} 结束，解冻晋级链：${affected.join("、")}`,
      payload: { appeal_id: appeal.id, source_bout_id: appeal.bout_id, affected_bout_ids: affected, by },
    });
  }

  // ---------- 候选结果、并列、签署、发布 ----------

  computeCandidate(cmd) {
    const state = this.state;
    const bout = this._getBout(cmd.bout_id);
    const evidence = acceptedEvidence(state, cmd.bout_id);
    const penalties = activePenalties(state, cmd.bout_id);
    const rulebook = state.rulebooks.get(bout.rulebook_id);
    const candidate = compute(bout.sport, {
      entries: bout.entries,
      evidence,
      penalties,
      config: rulebook?.config ?? {},
    });

    // 并列突破决定可强制给出唯一胜者
    const result = state.results.get(cmd.bout_id);
    const tieResolution = result?.tie_resolution;
    if (tieResolution) {
      const order = [tieResolution.winner, ...bout.entries.filter((id) => id !== tieResolution.winner)];
      candidate.entries.sort((a, b) => order.indexOf(a.athlete_id) - order.indexOf(b.athlete_id));
      candidate.entries.forEach((row, i) => {
        row.rank = i + 1;
        delete row.tie;
      });
      candidate.winners = [tieResolution.winner];
      delete candidate.tie;
      candidate.tie_resolution_id = tieResolution.event_id;
    }

    const usedEvidence = Object.values(evidence).flat().map((e) => e.event_id);
    const usedSanctions = penalties.map((p) => p.event_id);
    return this._append({
      event_type: "RESULT_CANDIDATE_COMPUTED",
      aggregate_type: "bout_result",
      aggregate_id: `result-${cmd.bout_id}`,
      correlation_id: cmd.bout_id,
      summary: `${cmd.bout_id} 形成候选名次（算法 ${candidate.algorithm}，仅供签署，未生效）`,
      payload: {
        bout_id: cmd.bout_id,
        sport: bout.sport,
        rules_version: bout.rules_version,
        candidate,
        used_evidence: usedEvidence,
        used_sanctions: usedSanctions,
        quarantined_count: [...state.evidence.values()].filter(
          (e) => e.bout_id === cmd.bout_id && e.status === "quarantined",
        ).length,
        computed_by: cmd.official_id,
      },
    });
  }

  resolveTie(cmd) {
    const state = this.state;
    this._getBout(cmd.bout_id);
    const result = state.results.get(cmd.bout_id);
    const latest = result?.candidates.at(-1);
    if (!latest) throw new DomainError("NO_CANDIDATE", "需先计算候选结果");
    if (latest.candidate.winners.length > 1 || latest.candidate.tie) {
      // 确属并列方可裁决
    } else if (!cmd.force) {
      throw new DomainError("NO_TIE", "候选结果不存在并列，无需突破");
    }
    return this._append({
      event_type: "TIE_RESOLVED",
      aggregate_type: "bout_result",
      aggregate_id: `result-${cmd.bout_id}`,
      correlation_id: cmd.bout_id,
      summary: `${cmd.bout_id} 并列突破：${cmd.method}，${cmd.winner} 列前`,
      payload: {
        bout_id: cmd.bout_id,
        method: cmd.method,
        winner: cmd.winner,
        reason: cmd.reason,
        decided_by: cmd.official_id,
      },
    });
  }

  certifyResult(cmd) {
    const state = this.state;
    const bout = this._getBout(cmd.bout_id);
    this._assertNotFrozen(cmd.bout_id);
    this._assertRole(cmd.official_id, "certify");
    const result = state.results.get(cmd.bout_id);
    const latest = result?.candidates.at(-1);
    if (!latest) throw new DomainError("NO_CANDIDATE", "尚无候选结果可签署");
    const unresolvedTie =
      latest.candidate.entries.some((e) => e.tie?.unresolved) ||
      latest.candidate.winners.length === 0; // 记分卡多数平等情况：无唯一胜者
    if (unresolvedTie) throw new DomainError("TIE_UNRESOLVED", "并列尚未突破，不能签署");
    if (bout.status !== "ended") throw new DomainError("BOUT_NOT_ENDED", "比赛尚未结束");

    const candidateEvent = this.store.all().find((e) => e.event_id === latest.event_id);
    return this._append({
      event_type: "RESULT_CERTIFIED",
      aggregate_type: "bout_result",
      aggregate_id: `result-${cmd.bout_id}`,
      correlation_id: cmd.bout_id,
      summary: `${cmd.official_id} 签署确认 ${cmd.bout_id} 候选名次`,
      payload: {
        bout_id: cmd.bout_id,
        candidate_event_id: latest.event_id,
        candidate_hash: candidateEvent.content_hash,
        standings: latest.candidate.entries.map(({ athlete_id, score, rank }) => ({
          athlete_id,
          score,
          rank,
        })),
        signer: {
          official_id: cmd.official_id,
          role: state.officials.get(cmd.official_id).roles.find((r) => ROLES.certify.includes(r)),
        },
      },
    });
  }

  publishResult(cmd) {
    const state = this.state;
    this._getBout(cmd.bout_id);
    this._assertNotFrozen(cmd.bout_id);
    this._assertRole(cmd.official_id, "publish");
    const result = state.results.get(cmd.bout_id);
    if (!result?.certified) throw new DomainError("NOT_CERTIFIED", "结果未经签署，不能发布");
    const cert = result.certified;
    return this._append({
      event_type: "RESULT_PUBLISHED",
      aggregate_type: "bout_result",
      aggregate_id: `result-${cmd.bout_id}`,
      correlation_id: cmd.bout_id,
      summary: `${cmd.bout_id} 正式成绩发布生效`,
      payload: {
        bout_id: cmd.bout_id,
        cert_event_id: cert.event_id,
        standings: cert.standings,
        published_by: cmd.official_id,
      },
    });
  }

  // ---------- 晋级 ----------

  confirmAdvancement(cmd) {
    const state = this.state;
    const bout = this._getBout(cmd.bout_id);
    this._assertNotFrozen(cmd.bout_id);
    if (!bout.draw_id) throw new DomainError("NOT_IN_DRAW", "该场不属于任何晋级括号");
    const result = state.results.get(cmd.bout_id);
    if (!result?.certified) throw new DomainError("NOT_CERTIFIED", "未签署的结果不能确认晋级");
    const draw = state.draws.get(bout.draw_id);
    const node = draw.bracket.get(cmd.bout_id);
    if (!node?.feeds_into) throw new DomainError("NO_NEXT_BOUT", "该场之后没有晋级目标场次");
    if (state.frozenBouts.has(node.feeds_into)) {
      throw new DomainError(
        "ADVANCEMENT_FROZEN",
        `下游场次 ${node.feeds_into} 处于冻结中`,
      );
    }
    const winners = result.certified.standings
      .filter((s) => s.rank <= (node.quota ?? 1))
      .map((s) => s.athlete_id);
    return this._append({
      event_type: "ADVANCEMENT_CONFIRMED",
      aggregate_type: "progression",
      aggregate_id: `prog-${bout.draw_id}`,
      correlation_id: cmd.bout_id,
      summary: `${cmd.bout_id} 晋级者 ${winners.join("、")} 进入 ${node.feeds_into}`,
      payload: {
        draw_id: bout.draw_id,
        bout_id: cmd.bout_id,
        target_bout_id: node.feeds_into,
        winners,
        confirmed_by: cmd.official_id,
      },
    });
  }

  // ---------- 奥运资格与纪录 ----------

  allocateOlympicQuota(cmd) {
    const state = this.state;
    const bout = this._getBout(cmd.bout_id);
    if (bout.sport !== "surfing") {
      throw new DomainError("NOT_OLYMPIC_EVENT", "奥运资格分配仅配置于冲浪奥运资格赛");
    }
    const result = state.results.get(cmd.bout_id);
    if (!result?.published) throw new DomainError("NOT_PUBLISHED", "只有正式发布的成绩可分配奥运配额");
    if (state.quotas.has(cmd.bout_id)) {
      throw new DomainError("QUOTA_ALREADY_ALLOCATED", `场次 ${cmd.bout_id} 配额已分配`);
    }
    return this._append({
      event_type: "OLYMPIC_QUOTA_ALLOCATED",
      aggregate_type: "olympic_quota",
      aggregate_id: `quota-${cmd.bout_id}`,
      correlation_id: cmd.bout_id,
      summary: `${cmd.bout_id} 奥运资格配额授予 ${cmd.athlete_id}，证据链锁定`,
      payload: {
        bout_id: cmd.bout_id,
        athlete_id: cmd.athlete_id,
        games: cmd.games,
        based_on_publish: result.published.event_id,
        allocated_by: cmd.official_id,
      },
    });
  }

  ratifyRecord(cmd) {
    const state = this.state;
    this._assertRole(cmd.official_id, "record");
    const result = state.results.get(cmd.bout_id);
    if (!result?.published) throw new DomainError("NOT_PUBLISHED", "纪录认证必须基于已发布成绩");
    const id = cmd.record_id ?? uid("rec");
    return this._append({
      event_type: "RECORD_RATIFIED",
      aggregate_type: "record",
      aggregate_id: id,
      correlation_id: cmd.bout_id,
      summary: `认证纪录：${cmd.label}`,
      payload: {
        bout_id: cmd.bout_id,
        athlete_id: cmd.athlete_id,
        label: cmd.label,
        value: cmd.value,
        publish_event_id: result.published.event_id,
        witnesses: cmd.witnesses ?? [],
      },
    });
  }
}
