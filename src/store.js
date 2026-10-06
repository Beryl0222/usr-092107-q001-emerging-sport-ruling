import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { GENESIS_HASH, hashEvent, nowIso } from "./envelope.js";

/**
 * 仅追加事件存储。
 *
 * - 每条事件落库时获得全局递增 seq，并与前一条事件用 SHA-256 串成哈希链；
 * - 同一聚合内通过 expectedVersion 做乐观并发控制；
 * - idempotency_key 用于离线设备补传去重：同键重复提交返回首次落库的事件；
 * - 存储只追加，任何更正都以“引用原记录的新事件”表达。
 *
 * 乱序：事件按接收顺序入链（决定先后关系不可改变），但事件携带 occurred_at
 * 表示事实发生时间，窗口判定与重放均以事件时间为准，迟到证据不影响可追溯性。
 */
export class EventStore {
  /** @param {{file?: string}} [options] */
  constructor(options = {}) {
    this.file = options.file;
    /** @type {Array<ReturnType<typeof decorate>>} */
    this.events = [];
    /** @type {Map<string, number>} 聚合 -> 最新版本 */
    this.aggregateVersions = new Map();
    /** @type {Map<string, StoredEventView>} 幂等键 -> 首次事件 */
    this.idempotency = new Map();
    /** @type {Map<string, number>} 事件 id -> seq，便于改判引用校验 */
    this.eventIndex = new Map();
    if (this.file && existsSync(this.file)) this._load();
  }

  _load() {
    const lines = readFileSync(this.file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line);
      this._index(event);
      this.events.push(event);
    }
  }

  _index(event) {
    this.aggregateVersions.set(event.aggregate_id, event.version);
    this.eventIndex.set(event.event_id, event.seq);
    if (event.idempotency_key) this.idempotency.set(event.idempotency_key, event);
  }

  /**
   * 追加事件。
   * @param {object} event makeEvent 产出的事件正文
   * @param {{expectedVersion?: number, idempotencyKey?: string}} [options]
   * @returns {{status: "appended"|"duplicate", event: object}}
   */
  append(event, options = {}) {
    const idemKey = options.idempotencyKey ?? event.idempotency_key;
    if (idemKey && this.idempotency.has(idemKey)) {
      return { status: "duplicate", event: this.idempotency.get(idemKey) };
    }

    const current = this.aggregateVersions.get(event.aggregate_id) ?? 0;
    const expected = options.expectedVersion;
    if (expected !== undefined && current !== expected) {
      const err = new Error(
        `聚合 ${event.aggregate_id} 版本冲突：期望 ${expected}，实际 ${current}`,
      );
      err.code = "VERSION_CONFLICT";
      throw err;
    }
    if (event.version !== current + 1) {
      const err = new Error(
        `聚合 ${event.aggregate_id} 版本必须连续：期望 ${current + 1}，收到 ${event.version}`,
      );
      err.code = "VERSION_GAP";
      throw err;
    }

    const prev = this.events.at(-1);
    const stored = {
      ...event,
      content_hash: hashEvent(event),
      prev_hash: prev ? prev.content_hash : GENESIS_HASH,
      seq: this.events.length + 1,
      stored_at: nowIso(),
    };

    this.events.push(stored);
    this._index(stored);
    if (this.file) {
      appendFileSync(this.file, `${JSON.stringify(stored)}\n`);
    }
    return { status: "appended", event: stored };
  }

  /** 同一聚合上一次已落库版本（0 表示尚未出现）。 */
  versionOf(aggregateId) {
    return this.aggregateVersions.get(aggregateId) ?? 0;
  }

  hasEvent(eventId) {
    return this.eventIndex.has(eventId);
  }

  /** 按幂等键取回首次落库的事件（离线重传去重）。 */
  findByIdempotent(key) {
    return this.idempotency.get(key);
  }

  all() {
    return [...this.events];
  }

  byAggregate(aggregateId) {
    return this.events.filter((event) => event.aggregate_id === aggregateId);
  }

  byType(eventType) {
    return this.events.filter((event) => event.event_type === eventType);
  }

  byCorrelation(correlationId) {
    return this.events.filter((event) => event.correlation_id === correlationId);
  }

  /** 按事实发生时间重放（同一时刻按入链序号打破并列）。 */
  replay(correlationId) {
    const events = correlationId
      ? this.byCorrelation(correlationId)
      : this.all();
    return [...events].sort((a, b) =>
      a.occurred_at < b.occurred_at
        ? -1
        : a.occurred_at > b.occurred_at
          ? 1
          : a.seq - b.seq,
    );
  }

  /**
   * 校验哈希链：任何记录被改写都会失配。
   * @returns {{valid: boolean, brokenAt?: number, reason?: string}}
   */
  verifyChain() {
    let prevHash = GENESIS_HASH;
    for (const event of this.events) {
      if (event.seq !== this.events.indexOf(event) + 1) {
        return { valid: false, brokenAt: event.seq, reason: "序号不连续" };
      }
      if (event.prev_hash !== prevHash) {
        return { valid: false, brokenAt: event.seq, reason: "前序哈希失配" };
      }
      const { content_hash, prev_hash, seq, stored_at, ...body } = event;
      if (hashEvent(body) !== content_hash) {
        return { valid: false, brokenAt: event.seq, reason: "正文哈希失配" };
      }
      prevHash = content_hash;
    }
    return { valid: true };
  }
}

/**
 * @typedef {object} StoredEventView
 * @property {string} event_id
 * @property {number} seq
 */
