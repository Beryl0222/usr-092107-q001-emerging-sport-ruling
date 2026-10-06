// 测试辅助：可控时钟的应用 + 标准签署官员 + 常用赛程搭建。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application.js";

export let clockHandle;

/** 从给定 ISO 时间起，每次取值 +1 秒的可控时钟。 */
export function fakeClock(startIso = "2026-10-06T08:00:00Z") {
  let t = Date.parse(startIso);
  const fn = () => new Date((t += 1000)).toISOString();
  fn.advance = (seconds) => {
    t += seconds * 1000;
    return fn();
  };
  fn.set = (iso) => {
    t = Date.parse(iso);
    return fn();
  };
  fn.peek = () => new Date(t).toISOString();
  return fn;
}

export function makeApp({ file = false, clock, start = "2026-10-06T08:00:00Z", officials = true } = {}) {
  const clk = clock ?? fakeClock(start);
  let storeFile;
  let tmpDir;
  if (file === true) {
    tmpDir = mkdtempSync(join(tmpdir(), "ruling-"));
    storeFile = join(tmpDir, "events.jsonl");
  } else if (typeof file === "string") {
    storeFile = file;
  }
  const app = createApplication({
    file: storeFile,
    clock: clk,
    officials: officials
      ? [
          { id: "arbiter", role: "result_arbiter", secret: "k-arbiter", name: "成绩仲裁" },
          { id: "head", role: "head_judge", secret: "k-head", name: "裁判长" },
          { id: "jury", role: "jury", secret: "k-jury", name: "仲裁团" },
          { id: "recorder", role: "chief_recorder", secret: "k-recorder", name: "总记录长" },
          { id: "tech", role: "technical_official", secret: "k-tech", name: "技术官员" },
        ]
      : [],
  });
  app.clockFn = clk;
  app.cleanup = () => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  };
  app.dir = () => storeFile;
  return app;
}

export const standardWindows = { evidence_minutes: 120, ingest_grace_minutes: 30, appeal_minutes: 60, review_minutes: 180 };

export function activateRule(app, sport, windows = standardWindows) {
  app.command("registerRuleVersion", { rule_id: `rule-${sport}`, sport, version_label: "2026.1", windows });
  app.command("activateRule", { rule_id: `rule-${sport}` });
}

export function eligible(app, id, nation) {
  app.command("confirmEligibility", { athlete_id: id, nation, status: "eligible" });
}

export function assignThreeJudges(app, boutId, nationsByJudge = { J1: [], J2: [], J3: [] }) {
  for (const [judge, nations] of Object.entries(nationsByJudge)) {
    app.command("assignJudge", { bout_id: boutId, judge_id: judge, role: "judge", nations });
  }
}
