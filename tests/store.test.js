import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { makeEvent, GENESIS_HASH, hashEvent } from "../src/envelope.js";
import { EventStore } from "../src/store.js";

let files = [];
afterEach(() => {
  files = [];
});

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "esr-"));
  const file = join(dir, "events.jsonl");
  files.push(file);
  return file;
}

test("事件按聚合版本连续落库并获得全局 seq 与哈希链", () => {
  const store = new EventStore();
  const e1 = store.append(makeEvent({
    event_type: "RULEBOOK_PUBLISHED", aggregate_type: "rulebook",
    aggregate_id: "r1", version: 1, summary: "a",
  })).event;
  const e2 = store.append(makeEvent({
    event_type: "RULEBOOK_ACTIVATED", aggregate_type: "rulebook",
    aggregate_id: "r1", version: 2, summary: "b",
  })).event;
  const e3 = store.append(makeEvent({
    event_type: "ATHLETE_REGISTERED", aggregate_type: "athlete",
    aggregate_id: "a1", version: 1, summary: "c",
  })).event;

  assert.equal(e1.seq, 1);
  assert.equal(e1.prev_hash, GENESIS_HASH);
  assert.equal(e2.seq, 2);
  assert.equal(e2.prev_hash, e1.content_hash);
  assert.equal(e3.prev_hash, e2.content_hash);
  assert.equal(store.versionOf("r1"), 2);
  assert.equal(store.versionOf("a1"), 1);
});

test("版本必须连续：跳跃版本被拒绝", () => {
  const store = new EventStore();
  store.append(makeEvent({
    event_type: "RULEBOOK_PUBLISHED", aggregate_type: "rulebook",
    aggregate_id: "r1", version: 1, summary: "a",
  }));
  assert.throws(
    () => store.append(makeEvent({
      event_type: "RULEBOOK_ACTIVATED", aggregate_type: "rulebook",
      aggregate_id: "r1", version: 3, summary: "jump",
    })),
    /版本必须连续/,
  );
});

test("期望版本冲突（乐观并发控制）", () => {
  const store = new EventStore();
  store.append(makeEvent({
    event_type: "RULEBOOK_PUBLISHED", aggregate_type: "rulebook",
    aggregate_id: "r1", version: 1, summary: "a",
  }));
  assert.throws(
    () => store.append(
      makeEvent({
        event_type: "RULEBOOK_ACTIVATED", aggregate_type: "rulebook",
        aggregate_id: "r1", version: 2, summary: "b",
      }),
      { expectedVersion: 0 },
    ),
    /版本冲突/,
  );
});

test("幂等键：重复提交返回首次落库的事件", () => {
  const store = new EventStore();
  const first = store.append(makeEvent({
    event_type: "EVIDENCE_RECORDED", aggregate_type: "evidence",
    aggregate_id: "ev1", version: 1, summary: "first", idempotency_key: "dev:msg:7",
  }));
  const second = store.append(makeEvent({
    event_id: "should-not-exist",
    event_type: "EVIDENCE_RECORDED", aggregate_type: "evidence",
    aggregate_id: "ev2", version: 1, summary: "dup", idempotency_key: "dev:msg:7",
  }));
  assert.equal(first.status, "appended");
  assert.equal(second.status, "duplicate");
  assert.equal(second.event.event_id, first.event.event_id);
  assert.equal(store.all().length, 1);
});

test("哈希链校验通过，篡改任一记录即失配", () => {
  const store = new EventStore();
  for (let i = 0; i < 3; i += 1) {
    store.append(makeEvent({
      event_type: "RULEBOOK_PUBLISHED", aggregate_type: "rulebook",
      aggregate_id: `r${i}`, version: 1, summary: `r${i}`,
    }));
  }
  assert.deepEqual(store.verifyChain(), { valid: true });
  const events = store.all();
  events[1].summary = "被改写";
  const verdict = store.verifyChain();
  assert.equal(verdict.valid, false);
  assert.equal(verdict.brokenAt, 2);
  assert.equal(verdict.reason, "正文哈希失配");
});

test("乱序事实时间：存储按接收顺序入链，replay 按事实时间重排", () => {
  const store = new EventStore();
  store.append(makeEvent({
    event_type: "EVIDENCE_RECORDED", aggregate_type: "evidence",
    aggregate_id: "late", version: 1, summary: "晚发生先到达",
    occurred_at: "2026-11-02T10:05:00Z",
  }));
  store.append(makeEvent({
    event_type: "EVIDENCE_RECORDED", aggregate_type: "evidence",
    aggregate_id: "early", version: 1, summary: "早发生后补传",
    occurred_at: "2026-11-02T10:00:00Z",
  }));
  const chainOrder = store.all().map((e) => e.aggregate_id);
  assert.deepEqual(chainOrder, ["late", "early"]);
  const replayOrder = store.replay().map((e) => e.aggregate_id);
  assert.deepEqual(replayOrder, ["early", "late"]);
});

test("JSONL 持久化：重启后事件、版本与幂等索引完整恢复", () => {
  const file = tempFile();
  const store1 = new EventStore({ file });
  store1.append(makeEvent({
    event_type: "EVIDENCE_RECORDED", aggregate_type: "evidence",
    aggregate_id: "ev1", version: 1, summary: "persisted", idempotency_key: "k9",
  }));
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);

  const store2 = new EventStore({ file });
  assert.equal(store2.all().length, 1);
  assert.equal(store2.versionOf("ev1"), 1);
  const dup = store2.append(makeEvent({
    event_type: "EVIDENCE_RECORDED", aggregate_type: "evidence",
    aggregate_id: "ev2", version: 1, summary: "dup after restart", idempotency_key: "k9",
  }));
  assert.equal(dup.status, "duplicate");
  assert.deepEqual(store2.verifyChain(), { valid: true });
});

test("hashEvent 对字段书写顺序不敏感、对值变化敏感（含嵌套 payload）", () => {
  const a = makeEvent({
    event_type: "EVIDENCE_RECORDED", aggregate_type: "evidence", aggregate_id: "e1",
    version: 1, summary: "s", payload: { z: 1, nested: { b: 2, a: "两" } },
  });
  // 手工调换 payload 与信封字段书写顺序
  const b = {
    payload: { nested: { a: "两", b: 2 }, z: 1 }, summary: "s", version: 1,
    aggregate_id: "e1", aggregate_type: "evidence", event_type: "EVIDENCE_RECORDED",
    event_id: a.event_id, occurred_at: a.occurred_at,
  };
  assert.equal(hashEvent(a), hashEvent(b));
  assert.notEqual(hashEvent(a), hashEvent({ ...a, payload: { z: 1, nested: { b: 2, a: "三" } } }));
  assert.notEqual(hashEvent(a), hashEvent({ ...a, summary: "不同" }));
});
