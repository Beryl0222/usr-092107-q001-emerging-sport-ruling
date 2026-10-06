# 新兴赛项裁判证据台

亚运会新增**冲浪、综合格斗、虚拟跆拳道**后，传统计时计分系统无法解释「主观打分 + 动作传感器 + 犯规裁决」如何共同形成最终名次，也无法在承担奥运资格赛时保证结果不被事后改写。

本仓库是一套**事件溯源（event-sourced）的裁判与成绩后端**：每一个决定——规则版本、资格、分组轮次、裁判指派与回避、设备校准、原始评分/传感器消息、犯规、改判、并列裁决、申诉、晋级、纪录认证——都作为**仅追加、带哈希链、可签名**的事件落库。系统可以把一场比赛从原始输入重放到公告名次，并独立验算每一步。

## 核心不变量

- **只追加，不覆盖**：记录一经接收，`event_id / occurred_at / version` 等永不原地改写。人工改判用 `SCORE_CORRECTED` **引用**原始记录（`correction_of`），原记录保留留档。
- **先后关系可证**：每条事件有全局 `seq`（接收顺序）、聚合内 `version`，并以 `prev_hash → hash`（canonical JSON 的 SHA-256）串成链。任何字段改写或事件重排都会让链校验失败。
- **离线补传安全**：传感器消息必须带 `idempotency_key`；重复补传幂等返回首条，同键不同载荷直接拒绝。乱序到达按接收顺序入链，`occurred_at`（设备发生时刻）与 `recorded_at`（接收时刻）分别保留。
- **自动计算只产生候选**：`RESULT_CANDIDATE_PROJECTED` 永远不对外。正式名次必须经 `RESULT_CERTIFIED`（裁判长/仲裁签署）与 `RESULT_PUBLISHED`（成绩仲裁签署）才生效。
- **奥运资格赛公告即锁定**：冲浪资格赛发布后追加 `RESULT_LOCKED`。改写只能走申诉改判，由仲裁 + 成绩仲裁双重授权，产生**新版本**，旧版本留档为 `superseded`，不删除。
- **申诉只冻结受影响的晋级链闭包**：冻结沿「源场次 → 下游场次」传播，其他场次/另一条链照常推进；申诉处理完即解冻。
- **规则窗口内受理**：证据窗口、补传宽限、申诉窗口、证据/复核窗口都由生效规则版本定义，超时拒绝；窗口只限制*接收*，不追溯否定已发生事实。
- **按角色可见**：官员可整场重放与验算；代表队只看本队申诉状态与截止时间；公开端只展示已生效且签名、哈希链均可核验的版本。

## 目录

```
contracts/domain.schema.json   事件信封 JSON Schema（事件类型/聚合类型/字段）
src/domain.ts                  事件信封的 TypeScript 类型（类型契约）
src/validator.js               事件信封结构校验
src/events/envelope.js         canonical JSON、SHA-256 哈希、事件 id
src/events/store.js            仅追加存储：序号/版本/哈希链/幂等/JSONL 持久化与启动校验
src/domain/scoring.js          三个赛项纯计分（无副作用，可独立验算）
src/domain/compute.js          从折叠状态构建候选结果（被命令与重放共用）
src/domain/fold.js             事件流 → 当前状态快照（在线处理与重放同一套折叠）
src/domain/signing.js          签署登记：HMAC 签名 + 角色/法定人数策略
src/domain/backend.js          全部领域命令（规则、资格、轮次、裁判、设备、证据、改判、申诉、晋级、纪录）
src/domain/replay.js           官员视图：整场重放 + 逐候选重算比对 + 公告验签
src/domain/delegation-view.js  代表队视图：申诉状态与窗口倒计时
src/domain/public-view.js      公开视图：仅生效可核验版本 + 公众哈希核验
src/application.js             装配门面
src/server.js                  零依赖 HTTP 适配层
src/main.js                    服务入口
data/sample.json               一条中文样例事件
tests/                         node:test 测试（存储/计分/端到端工作流/HTTP/持久化）
```

## 三个赛项如何形成名次

| 赛项 | 输入 | 计分 | 并列处理 |
|---|---|---|---|
| 冲浪 | 每位裁判对每道浪 0–10 主观分 | 每道浪去最高/最低取平均；每名选手取**两条最高浪之和**；干扰罚分扣减 | 总分 → 最高单浪 → 次高单浪回算；仍相同则挂起，裁判长显式裁决 |
| 综合格斗 | 三名边裁 10 分制计分卡 + 犯规扣分 | 扣分在回合有效分中先行扣除；按裁判卡汇总一致/多数/分歧判定或平局 | 一致/分歧平局挂起，裁判长依控制等显式裁决 |
| 虚拟跆拳道 | 已校准设备的有效传感器消息 + 扣分 | 有效踢得分，对方扣分记己方 +1；三回合合计 | 平分进**金赛点**（首得分者胜）→ 无得分按**有效接触次数**优势 → 仍平由仲裁显式裁决 |

设备消息是否「有效」由**发生时刻的设备状态**决定：未登记、赛项不符、发生时未通过校准、已被宣布不可靠、或超出窗口，都会标记 `valid=false` 并留痕（不静默丢弃），但不参与计分。

## 结果生命周期

```
原始证据(RAW_SCORE / SENSOR_MESSAGE / FOUL)
        │  自动计算
        ▼
RESULT_CANDIDATE_PROJECTED（候选，不对外）
        │  并列须先 TIEBREAK_RESOLVED
        ▼
RESULT_CERTIFIED（裁判长/仲裁签名）
        ▼
RESULT_PUBLISHED（成绩仲裁签名 → 公开端可见）
        ▼（奥运资格赛）
RESULT_LOCKED
        │  申诉成立且改判（仲裁 + 成绩仲裁授权）
        ▼
新版本 CERTIFIED → PUBLISHED（旧版本进入 history，标注 superseded）
```

申诉被**驳回或撤回**时，挂在该申诉下的改判作废，被取代的原始证据「复活」，生效的公告版本始终不变。

## HTTP 接口

签署密钥保存在服务端，请求只携带签署人标识；签名由服务端对事件哈希即时生成并验签。

- `POST /commands/<命令名>`：执行领域命令（body 为命令参数，`signers` 为签署人 id 列表）
- `GET  /public/results?sport=surfing`：公开成绩（仅已发布/锁定、可核验）
- `GET  /public/verify/<eventId>?hash=...`：公众独立核验一条公告
- `GET  /delegation/<代表队>/appeals`：代表队申诉状态与截止时间
- `GET  /official/bouts/<boutId>/replay`：官员整场重放与验算
- `GET  /official/chain`：全库哈希链状态
- `GET  /events/<eventId>`：按标识取事件
- `GET  /health`

### 快速开始

```bash
npm test                 # 运行全部测试（零依赖，node:test）
node src/main.js --demo  # 启动演示服务（内置五名签署官员），默认 :8080
# 持久化到文件并在重启后重放：
node src/main.js --demo --file data/events.jsonl --port 8080
```

一次最小流程（演示服务已内置 `head` 裁判长与 `arbiter` 成绩仲裁的密钥）：

```bash
curl -s -XPOST localhost:8080/commands/registerRuleVersion -H 'content-type: application/json' \
  -d '{"rule_id":"r-surf","sport":"surfing","version_label":"2026.1","windows":{"evidence_minutes":120,"appeal_minutes":60,"review_minutes":180}}'
curl -s -XPOST localhost:8080/commands/activateRule -H 'content-type: application/json' -d '{"rule_id":"r-surf"}'
# ……confirmEligibility / scheduleBout / finalizeRoster / assignJudge / startRound /
#     submitJudgeScore ……
curl -s -XPOST localhost:8080/commands/projectCandidate -H 'content-type: application/json' -d '{"bout_id":"B1"}'
curl -s -XPOST localhost:8080/commands/certifyResult  -H 'content-type: application/json' -d '{"bout_id":"B1","signers":["head"]}'
curl -s -XPOST localhost:8080/commands/publishResult  -H 'content-type: application/json' -d '{"bout_id":"B1","signers":["arbiter"]}'
curl -s localhost:8080/public/results
```

申诉改判流程见 `tests/workflow.test.js`（`申诉改判引用原始记录、产生新版本公告`）：`fileAppeal` →（窗口期内）`submitAppealEvidence` / `logReview` → `correctScore`（引用原记录）→ `decideAppeal {outcome:"upheld", signers:["jury"], publish_signers:["arbiter"]}`，系统据此重算候选、重新签署、发布新版本并解除晋级链冻结。

## 隐私

个人、机构及商业敏感信息仅随事件在履行职责所需的视图中开放：公开视图不含裁判身份明细与内部复核内容；代表队视图隔离到本队；官员重放面向有权限的赛事官员。
