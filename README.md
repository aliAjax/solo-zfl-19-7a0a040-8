# 手摇风琴纸带打孔 API

纯后端零依赖 Node 服务（仅用 Node 内置模块），`data/db.json` 持久化两部分数据：

1. 曲目 / 纸带区间 / 试奏问题
2. **冲孔机台健康监测**：按批次上报张力、孔径、转速，连续异常窗口生成故障

## 启动 / 测试

```bash
node server.js                 # 默认端口 3019，库文件 data/db.json
PORT=3019 DB_FILE=/data/db.json node server.js
npm test                       # node --test test/（41 个用例）
```

## 纸带管理接口（原有，已保持回归）

- `GET  /health`
- `GET  /tunes` / `POST /tunes`
- `GET  /tunes/:id/progress`
- `GET  /tunes/:id/sections` / `POST /tunes/:id/sections`
- `GET  /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET  /issues?tuneId=&status=` / `POST /issues`
- `PATCH /issues/:id/status`

## 机台健康监测

### 数据模型

- **机台 machine**：`code`、`windowSize`（连续异常窗口，默认 3）、`timeoutMs`（掉线阈值，默认 60s）、
  每项指标的 `warning/critical` 双阈值（critical 区间必须包含 warning）。
- **样本 sample**：`ts`（毫秒时间戳或 ISO 字符串，允许相对服务器时间 ±5 分钟）、`seq`、
  `tension(N)`、`holeDiameter(mm)`、`rpm`。
- **故障 fault**：`open` → `confirmed` → `closed`；也可能被系统自动关闭。

### 判定语义

- 指标落在 warning 区间外记 warning，落在 critical 区间外记 critical；阈值边界本身算正常。
- **同一连续异常段达到 `windowSize` 个异常样本才创建 `open` 故障**；最新样本恢复正常即视为连续中断，
  未确认故障自动关闭（`reason=streak_broken`）。
- 故障未确认期间，后续异常样本只**补充**；出现更严重级别时**升级**（`open` 故障全局唯一，绝不重复新建）。
- **批次幂等**：同一 `(机台, batchId)` 重放返回首次结果，不重复落库；跨批次相同 `(ts, seq)` 天然去重。
- **乱序归位**：样本按 `ts`（再按 `seq`）排序后整体重算，迟到样本可补建/补充故障。
- **掉线降级**：超过 `timeoutMs` 未收到上报，周期扫描（30s）把状态持久化为 `offline`；
  再次上报自动恢复 `online`。边界按 `now - lastReportAt >= timeoutMs`。
- **维修暂停告警**：维修期间上报只入库不判定（样本带 `judged:false`）；开始维修时未确认故障自动关闭；
  结束后只评估 `endedTs` 之后的新样本。
- **确认后重新计数**：确认时刻之后的样本才能组成新的连续段，旧故障不会被复活。

### 接口

| 方法 路径 | 说明 |
| --- | --- |
| `POST /machines` | 注册机台 `{code,name?,windowSize?,timeoutMs?,thresholds?}` |
| `GET  /machines?status=` | 机台列表（含实时投影 `effectiveStatus`） |
| `GET  /machines/:id` | 单机台（:id 为机台 id 或 code） |
| `POST /machines/:id/samples` | 批次上报 `{batchId, samples:[{ts,seq,tension,holeDiameter,rpm}]}`，返回 `{duplicate,action,faultId,accepted,rejected}`，`action` ∈ `none/created/supplemented/upgraded/deferred/fault_auto_closed` |
| `POST /machines/:id/maintenance/start` | `{reason?,startedTs?}`；返回被自动关闭的故障 id |
| `POST /machines/:id/maintenance/end` | `{endedTs?}`；返回新窗口下界 `evaluateAfterTs` |
| `GET  /samples?machineId=&from=&to=` | 样本查询（时间闭区间，按时间排序） |
| `GET  /faults?machineId=&status=&level=&from=&to=` | 故障查询（from 按 lastAt、to 按 startedAt，创建时间倒序） |
| `GET  /faults/:id` | 单故障（含完整 history） |
| `POST /faults/:id/confirm` | 确认 `{note?}`（open → confirmed，409 防重复） |
| `POST /faults/:id/close` | 关闭 `{note?}`（409 防重复） |
| `POST /admin/sweep` | 立即执行一次掉线扫描 |

### 示例

```bash
curl -X POST http://127.0.0.1:3019/machines \
  -H 'Content-Type: application/json' \
  -d '{"code":"PUNCH-01","windowSize":3}'

NOW=$(node -e 'console.log(Date.now())')
curl -X POST http://127.0.0.1:3019/machines/PUNCH-01/samples \
  -H 'Content-Type: application/json' \
  -d "{\"batchId\":\"b-20260914-1\",\"samples\":[
    {\"ts\":$NOW,\"seq\":0,\"tension\":70,\"holeDiameter\":5.0,\"rpm\":1000},
    {\"ts\":$((NOW+1000)),\"seq\":1,\"tension\":71,\"holeDiameter\":5.0,\"rpm\":1000},
    {\"ts\":$((NOW+2000)),\"seq\":2,\"tension\":72,\"holeDiameter\":5.0,\"rpm\":1000}
  ]}"
# => {"action":"created","faultId":"fault_...","accepted":3}
```

## 一致性与持久化保证

- 所有更新经进程内互斥队列串行化（并发上报不丢样本、不重复建故障）。
- 落盘采用 **写临时文件 → fsync → rename**：写失败只留下/删除临时文件，`db.json` 永远是完整版本；
  写失败时内存同步回滚，故障与机台状态在同一次写入中落库，不存在半个事件。
- 重启后从磁盘恢复并立即做一次掉线扫描；旧版 db.json（无健康集合）启动时自动迁移，旧数据不丢。

## 测试覆盖

`npm test`：窗口判定、补充/升级、批次幂等、跨批次去重、乱序归位、维修暂停与新窗口、
掉线边界（含 `== timeoutMs`）、确认后重计数、查询过滤、参数校验、±5 分钟时间边界、
真实 HTTP 并发、写失败回滚、重启一致性、旧库迁移，以及全部纸带管理旧接口回归。
