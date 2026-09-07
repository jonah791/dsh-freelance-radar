# dsh-freelance-radar

自由职业任务雷达——支撑主人的自由人/数字游民路线（2026-09-03 主人指示开发）。

聚合公开远程任务源（v1 = 电鸭社区 API）→ 按主人能力画像（AI Agent / LLM 定制 + 排除词）打分筛选 → 工具面呈现 + 每日摘要。只读采集、主人决策闭环，**不自动投标**（合规红线）。

设计文档：`docs/freelance-radar-design.md`

## 工具面

| 工具 | 作用 |
|------|------|
| `radar_scan` | 采集远程任务（电鸭 API）→ 入库去重 → 打分排序 → 高分清单 |
| `radar_list` | 查看已收集任务（按状态/来源/分数过滤） |
| `radar_mark` | 标记任务（considered 考虑中 / applied 已投 / ignored 忽略） |
| `radar_digest` | 今日摘要：高分新任务 + 待跟进提醒（considered 超 3 天） |

## 数据源（实测 2026-09-03）

- 电鸭社区：`https://svc.eleduck.com/api/v1/posts?category=5&page=N`（HTTP 200 验证，25 条/页）
  - tags id 17=远程工作 / 18=线上兼职；category 5=招聘&找人
- RSS 源（Jobicy/RemoteOK 等）：v1 预留，后续接入

## 能力画像（Config profile 可覆盖）

```yaml
includeTags: [AI, 人工智能, LLM, 大模型, Agent, 远程, 线上兼职, 全栈]
includeKeywords: [ai, llm, agent, gpt, 大模型, 智能体, 全栈, typescript, python, chatbot, rag]
excludeKeywords: [区块链, web3, 币圈, 博彩, 刷单, 灰产]
minScore: 60
```

## 打分规则

| 维度 | 权重 |
|------|------|
| 关键词命中（title 2x） | 40 |
| 标签命中 | 20 |
| 远程友好 | 15 |
| 新鲜度（3 天内满分，14 天衰减） | 15 |
| 质量信号（详细 JD/未关闭） | 10 |
| 排除词命中 | 硬过滤 |

## 配置

```ts
interface Config {
  enabled: boolean
  dataDir?: string          // 默认 $DSH_HOME/freelance-radar
  eleduckApiBase?: string   // 默认 https://svc.eleduck.com/api/v1
  profile?: Partial<RadarProfile>
  rssSources?: string[]
}
```

## 数据文件

- `$DSH_HOME/freelance-radar/jobs.json`：已见任务（去重 + 状态 new/considered/applied/ignored）
