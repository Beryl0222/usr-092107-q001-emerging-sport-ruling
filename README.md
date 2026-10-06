# 新兴赛项裁判与成绩后端（裁判证据台）

亚运会新增**冲浪、综合格斗、虚拟跆拳道**三个赛项后，传统计时计分系统无法解释
“主观打分 + 动作传感器 + 犯规裁决”如何共同形成最终名次。本后端以**仅追加事件日志**
为唯一事实来源，管理从规则版本到公告名次的完整链路，并满足：

- 离线设备补传可能**重复或乱序**：幂等键去重、事实时间与接收时间分离；
- 人工改判**必须引用原记录**（`RULING_AMENDED`），原记录保留为 `superseded`，绝不覆盖；
- 申诉期间**只冻结受影响的晋级链**（本场及其下游括号），其他场次照常完赛、签署、发布；
- 证据与复核意见只在**规则允许的窗口**内接收；
- 自动计算只产生**候选结果**，正式发布必须经过有签署权限的官员；
- 冲浪作为奥运资格赛，配额一旦分配，相关**证据链锁定**，不可事后改写；
- 赛事官员可**重放**一场比赛从原始输入到公告名次的全过程，公开成绩只展示**已生效且可核验**的版本。

## 架构

```
命令（HTTP/调用）           事件日志（唯一事实来源）              读视图（纯派生）
─────────────────          ────────────────────────             ─────────────────
RulingService      ──append──▶  EventStore（内存/JSONL）  ──fold──▶  世界状态投影
（规则/资格/裁判/设备/        · 全局 seq + SHA-256 哈希链            （projection）
 证据/处罚/改判/申诉/        · 聚合版本乐观并发                   ├─ officialReplay 官员重放
 候选/签署/晋级/配额）       · idempotency_key 去重                ├─ teamView       代表队视图
        ▲                    · occurred_at 事实时间（可迟到）      └─ publicView     公开可核验成绩
        │                    · causation/correlation 因果关系
   scoring.js 纯函数         更正永远是“引用原记录”的新事件
 （冲浪/MMA/虚拟跆拳道，
  带算法版本号，可复现）
```

关键不变量：**任何已落库记录都不会被修改或删除**；状态、视图、候选名次全部可从日志重建。

## 目录

| 路径 | 说明 |
| --- | --- |
| `contracts/domain.schema.json` | 事件信封、16 类聚合与 38 类事件的契约 |
| `src/envelope.js` | 事件信封、规范化 SHA-256 摘要、可注入时钟 |
| `src/store.js` | 仅追加存储：哈希链、版本控制、幂等、JSONL、链校验、重放 |
| `src/projection.js` | 事件流 → 世界状态（证据取代链、冻结集、晋级括号等） |
| `src/scoring.js` | 三赛项纯函数评分引擎（候选结果，带算法版本） |
| `src/services.js` | 领域服务：全部业务规则与守卫（窗口、回避、锁定、签署权限…） |
| `src/views.js` | 官员重放 / 代表队视图 / 公开成绩 / 单事件核验 |
| `src/server.js` | `node:http` 适配：命令总线 `POST /api/cmd/:name` + 只读端点 |
| `src/domain.ts` | 事件与聚合词汇的 TypeScript 说明 |
| `scripts/demo.js` | 端到端故事线演示 |
| `tests/` | 存储、领域、评分、视图、HTTP 集成共 40+ 个用例 |

## 三个赛项的成绩如何形成

- **冲浪**：每条浪由裁判组打 0–10 分，组内**去极值平均**；每名运动员取得分最高的
  两条浪求和；干扰犯规按规则扣总分。奥运资格赛结果发布并分配配额后证据链锁定。
- **综合格斗**：十分制记分卡，三名裁判逐轮独立打分；台上裁判的扣分对全体记分卡生效；
  KO/降服等终止证据直接定胜；按票数输出一致/分歧/多数判定或多数平（并列待突破）。
- **虚拟跆拳道**：电子传感器命中计分（躯干 2、头部 5，分值在规则版本中可调），
  gam-jeom 犯规给对方加 1 分，可融合裁判技术艺术分。**仅**来自“已绑定本场、
  事实时间处于有效校准期内”设备的消息才计为证据，其余进入隔离区且不参与计算。

所有引擎输出都是 `RESULT_CANDIDATE_COMPUTED`：并列时名次带 `tie.unresolved`，
需 `TIE_RESOLVED` 突破后重算；签署（`RESULT_CERTIFIED`）与发布
（`RESULT_PUBLISHED`）是两个独立动作，分别要求签署/发布角色。

## 决定的生命周期与守卫

- **窗口**：场次结束时按当时生效规则版本计算证据截止与申诉截止时间；窗口外的证据、
  新申诉一律拒绝（复核中的申诉除外）。
- **回避**：裁判登记利益冲突（国籍、同队等），指派面板时强制校验。
- **改判**：只能引用**现行版本**；已作废/已被取代的记录不能再次改判；
  申诉成立前必须先完成引用式改判。
- **定向冻结**：申诉受理即冻结 `下游闭包 = 本场 ∪ 沿 bracket.feeds_into 的全部下游场次`；
  冻结只拦截这些场次的**晋级确认**，其他场次的比赛、签署、发布不受影响。
- **签署权限**：`jury_president / chief_referee / technical_delegate` 可签署，
  `jury_president / technical_delegate` 可发布，`record_committee` 认证纪录。
- **可核验性**：发布事件引用签署事件，签署事件引用候选事件并锚定其内容哈希；
  公开视图在哈希链异常时**不公布任何成绩**。

## HTTP 接口

```bash
# 启动（默认内存存储；设 EVENT_LOG_FILE 落 JSONL）
PORT=8080 EVENT_LOG_FILE=./data/event-log.jsonl node src/server.js
```

- `POST /api/cmd/:command`：请求体即命令字段；离线补传可带 `Idempotency-Key` 头。
- `GET /api/bouts/:boutId/replay`：官员重放（时间线、现行/隔离/被取代证据、改判链、
  申诉、候选、签署、发布、哈希锚点）。
- `GET /api/teams/:teamId`：代表队视图（成绩阶段、申诉状态与截止时间、冻结标记）。
- `GET /api/public/results`：公开成绩（仅已发布且链完好，带三级核验锚点）。
- `GET /api/events/:eventId/verify`：重算单事件正文哈希。
- `GET /api/chain/verify`：全链校验；`GET /api/events`：原始事件流。

命令名即 `RulingService` 的公开方法，例如：
`publishRulebook`、`grantEligibility`、`assignPanel`、`calibrateDevice`、
`recordEvidence`、`imposePenalty`、`amendRuling`、`fileAppeal`、`openReview`、
`issueOpinion`、`decideAppeal`、`computeCandidate`、`resolveTie`、
`certifyResult`、`publishResult`、`confirmAdvancement`、
`allocateOlympicQuota`、`ratifyRecord`。

## 本地检查

```bash
node --test        # 全部测试
node scripts/demo.js   # 端到端演示（含篡改后链校验失败的演示）
```

演示故事线覆盖：规则版本切换、回避拦截、离线乱序与重复补传、设备校准隔离、
申诉定向冻结与其他场次照常推进、引用式改判与复核意见、并列突破、
签署/发布分离、晋级确认、奥运配额锁定、纪录认证、三类视图与防篡改。

## 隐私

个人、机构及商业敏感信息仅向履行职责所需的调用方开放：公开视图不包含
裁判身份、内部复核意见与隔离证据；代表队视图只返回本队相关场次且不含审议细节。
