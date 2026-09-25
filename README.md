# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次和批次事件（暂挂/恢复/结项记录）。

## 文件结构

- `server.js` — 启动入口
- `src/api.js` — 接口处理（路由、参数解析、响应）
- `src/batchRules.js` — 业务规则（开批、暂挂、恢复、结项、领用校验、事件记录）
- `src/store.js` — 记录读写（`data/db.json` 的加载、兼容与写回）

## 启动

```bash
PORT=3020 node server.js
```

## 状态流转

- 批次：`open`（进行中）→ `suspended`（暂挂）→ `open`（恢复）→ `completed`（已结项）
- 缺损：`pending`（待修）→ `in_repair`（处理中）→ `repaired`（已修复）

暂挂规则：

- 暂挂必须记录原因和操作人；正在处理的缺损回到待修，但仍锁定在本批次，别的批次不能领走，也不能修改
- 已提交成功（repaired）的修复结果继续保留
- 暂挂期间批次不能结项；恢复后未完成的缺损回到处理中接着做
- 结项仍逐项核对修复后图片和修复说明（可用 `defaultAfterPhotoUrl` / `defaultRepairNote` 兜底）
- 重复提交同一结果不重复记账：已入账缺损结果一致则跳过，不一致返回 409；重复结项幂等返回，不重复记事件

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`（含该批次全部事件记录）
- `POST /batches/:id/suspend`（body：`reason`、`operator` 必填）
- `POST /batches/:id/resume`（body：`operator` 必填）
- `POST /batches/:id/complete`
- `GET /batches/:id/events`（该批次的暂挂/恢复/结项记录）
- `GET /events?batchId=&action=`（全局事件查询，`action` 可取 `suspend`/`resume`/`complete`）

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"],"operator":"王师傅"}'

# 临时停电：暂挂（记录原因和操作人）
curl -X POST http://127.0.0.1:3020/batches/<batchId>/suspend \
  -H 'Content-Type: application/json' \
  -d '{"reason":"临时停电","operator":"王师傅"}'

# 来电后恢复，接着做未完成项
curl -X POST http://127.0.0.1:3020/batches/<batchId>/resume \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李师傅"}'

# 全部完成后结项（逐项核对图片和说明）
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李师傅","results":[{"damageId":"damage_demo_1","afterPhotoUrl":"https://example.local/after-1.jpg","repairNote":"补纸加固"},{"damageId":"damage_demo_2","afterPhotoUrl":"https://example.local/after-2.jpg","repairNote":"镶补撕裂"}]}'

# 查询暂挂/恢复/结项记录
curl http://127.0.0.1:3020/batches/<batchId>/events
```
