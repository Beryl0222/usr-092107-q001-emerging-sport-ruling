#!/usr/bin/env node
// 服务入口：node src/main.js [--file data/events.jsonl] [--port 8080]
import { parseArgs } from "node:util";
import { createApplication } from "./application.js";
import { createHttpServer } from "./server.js";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: process.env.RULING_STORE ?? "" },
    port: { type: "string", default: process.env.PORT ?? "8080" },
    demo: { type: "boolean", default: false },
  },
});

// 预置签署官员仅用于本地/演示；生产通过密钥管理系统 enroll。
const demoOfficials = values.demo
  ? [
      { id: "arbiter", role: "result_arbiter", secret: process.env.ARBITER_SECRET ?? "demo-arbiter-key", name: "成绩仲裁" },
      { id: "head", role: "head_judge", secret: process.env.HEAD_SECRET ?? "demo-head-key", name: "裁判长" },
      { id: "jury", role: "jury", secret: process.env.JURY_SECRET ?? "demo-jury-key", name: "仲裁团" },
      { id: "recorder", role: "chief_recorder", secret: process.env.RECORDER_SECRET ?? "demo-recorder-key", name: "总记录长" },
      { id: "tech", role: "technical_official", secret: process.env.TECH_SECRET ?? "demo-tech-key", name: "技术官员" },
    ]
  : [];

const app = createApplication({ file: values.file || undefined, officials: demoOfficials });
const chain = app.verifyChain();
if (!chain.ok) {
  console.error("事件链完整性校验失败，拒绝启动：", chain);
  process.exit(1);
}
const server = createHttpServer(app);
server.listen(Number(values.port), () => {
  console.log(`新兴赛项裁判证据台监听 :${values.port}（事件 ${chain.count} 条，存储 ${values.file || "内存"}）`);
});
