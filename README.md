# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次、修复记账和批次事件。

## 目录结构

- `server.js`：服务入口
- `src/store.js`：记录读写（`data/db.json` 的加载、迁移与写回）
- `src/rules.js`：业务规则（批次领取、结果提交记账、暂挂、恢复、结项核对）
- `src/api.js`：接口处理（路由、请求解析、响应）

## 启动

```bash
PORT=3020 node server.js
```

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
- `GET /batches/:id`
- `POST /batches/:id/results` 逐项提交修复结果（`damageId`、`afterPhotoUrl`、`repairNote`，可带 `resultKey` 幂等去重，重复提交不重复记账）
- `POST /batches/:id/suspend` 暂挂批次（必填 `reason`、`operator`；未提交结果的缺损回到待修并锁定，已提交的结果保留）
- `POST /batches/:id/resume` 恢复批次（必填 `operator`；未完成项重新进入修补中）
- `POST /batches/:id/complete` 结项（暂挂中不可结项；逐项核对图片和说明，缺一不可）
- `GET /batches/:id/events` 查询该批次每次暂挂、恢复和结项记录

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 逐项提交结果
curl -X POST http://127.0.0.1:3020/batches/<batchId>/results \
  -H 'Content-Type: application/json' \
  -d '{"damageId":"damage_demo_1","afterPhotoUrl":"https://example.local/after-014-1.jpg","repairNote":"补纸填平虫蛀孔","operator":"张师傅"}'

# 临时停电：暂挂（记录原因和操作人），来电后恢复接着做
curl -X POST http://127.0.0.1:3020/batches/<batchId>/suspend \
  -H 'Content-Type: application/json' \
  -d '{"reason":"修复组临时停电","operator":"张师傅"}'
curl -X POST http://127.0.0.1:3020/batches/<batchId>/resume \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张师傅"}'

# 全部完成后结项，并查询暂挂/恢复/结项记录
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张师傅"}'
curl http://127.0.0.1:3020/batches/<batchId>/events
```
