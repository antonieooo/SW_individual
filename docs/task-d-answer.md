# Task D - Schemathesis 契约测试深度分析

## 1. 测试执行与认证合规性（对应评分：基于合规身份认证的测试正确执行情况）

本次 Task D 不仅覆盖 5 个核心服务，还覆盖了架构中的 2 个扩展服务，共 7 个服务：
- `api-gateway-service`
- `user-service`
- `ride-service`
- `bike-inventory-service`
- `payment-service`
- `partner-analytics-service`
- `database-cluster-service`

执行脚本与证据：
- 全量 Schemathesis：[`openapi/tests/schemathesis/run_task_d.sh`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/run_task_d.sh)
- 负向认证：[`openapi/tests/schemathesis/run_auth_negative.sh`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/run_auth_negative.sh)
- 负向数据：[`openapi/tests/schemathesis/run_negative_data.sh`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/run_negative_data.sh)

本轮测试不是“裸跑接口”，而是携带边界相关凭据执行：
- 通用：`Authorization`, `x-internal-mtls`
- 设备边界：`x-device-cert`
- 幂等边界：`Idempotency-Key` / `x-idempotency-key`
- 第三方边界：`x-api-key`
- 数据库边界：`x-db-credential`

此外，Gateway 对外入口已切到 HTTPS，Schemathesis 在自签名证书场景下使用 `--tls-verify false`，保证了测试环境与边界设计（TB1/TB4/TB5）的协议一致性。

## 2. 日志质量与完整性（对应评分：日志的质量与完整性）

日志具备完整审计链：
- 每个服务一个独立日志文件。
- 每份日志包含命令行、四个阶段（Examples/Coverage/Fuzzing/Stateful）、失败/告警分类、样本量、seed。
- 同时保存多个时间点日志，能体现调试收敛过程而非一次性结果。

关键日志目录：
- 初始高失败：[`20260305-000953`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-000953)
- 中期收敛（失败清零，仍有 warning）：[`20260305-105043`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-105043)
- 全绿（默认 warning off）：[`20260305-212250`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-212250)
- 全绿 + 开启 warning 分析视图：[`20260305-223326`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326)

## 3. 调试过程复盘：我在 Schemathesis 阶段遇到的真实问题（对应评分：测试结果的深度分析）

### 3.1 第一阶段：高失败暴露“契约-实现漂移”

在 `20260305-000953` 目录中，多个服务仍有显著失败：
- user-service: 6 failures
- ride-service: 4 failures
- bike-inventory-service: 9 failures
- payment-service: 2 failures

高频问题类型：
- `API rejected schema-compliant request`
- `API accepted schema-violating request`
- `Undocumented Content-Type`
- `Response violates schema`

这说明当时主要矛盾不是服务挂了，而是“规范与实现没有对齐”：文档允许的请求被代码拒绝，或代码接受了文档本应拒绝的请求。

### 3.2 第二阶段：工具链和执行环境问题

除了业务契约问题，还遇到过会直接阻断测试执行的工程问题：

1. Schemathesis 在 CI 中无法执行
- 现象：`.venv-schemathesis/bin/schemathesis: cannot execute: required file not found`
- 后续又出现：`No module named schemathesis.__main__`
- 根因：不同环境中 CLI 入口可用性不同，`python -m schemathesis` 在该版本并非正确入口
- 修复：`run_task_d.sh` 增加命令 fallback（`schemathesis` / `st` / `python -m schemathesis.cli`）

2. 服务就绪检查不稳定
- 现象：`curl: (52) Empty reply from server`、`curl: (56) Recv failure`
- 根因：容器刚启动时时序问题 + 网关切到 HTTPS 后探针未统一处理
- 修复：Readiness 统一重试，并对 HTTPS 路径使用 `curl -k`

这一步的价值是把“测试框架本身是否可靠”先解决，否则后续任何失败都不可信。

### 3.3 第三阶段：针对典型失败逐类修复

1. `Undocumented Content-Type: text/html`
- 根因：Express 默认 body-parser 错误直接返回 HTML 错页
- 修复：补 JSON 解析异常中间件，统一返回 JSON 结构化错误
- 意义：错误响应也纳入契约，不再出现“成功时按规范、失败时随框架默认”的不一致

2. `API rejected schema-compliant request`
- 根因：schema 过宽（例如可选字段、宽松字符串），运行时业务校验更严格
- 修复：收紧 OpenAPI 约束（pattern、required、additionalProperties），并同步运行时校验
- 意义：避免“规范看起来可用，客户端按规范调用却被拒绝”

3. `API accepted schema-violating request`
- 根因：实现层未完整拦截非法 path/query/body
- 修复：补 path ID 格式约束、query allowlist、payload 严格对象校验
- 意义：防止非法数据穿透边界进入核心逻辑

4. 身份认证 warning 噪音
- 现象：管理接口出现 `Missing authentication`
- 根因：测试 token 与管理员接口角色不匹配
- 修复：主流程改用 maintainer token；同时保留 `run_auth_negative.sh` 验证未授权请求确实被拒绝
- 意义：把“预期拒绝”与“真实缺陷”区分开，减少误判

5. 缺少测试数据 warning
- 现象：`Missing valid test data`（多见于 ride 状态链）
- 根因：属性测试生成的 ID 语法合法但资源不存在，触发 404
- 修复：通过 schema 收敛和流程调整降低噪音；并在报告中解释其含义
- 意义：这类告警反映测试数据前置条件，而非安全边界失效

## 4. 当前结果与“可解释 warning”结论

最新“可解释 warning 视图”日志：[`20260305-223326`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326)

结论：
1. 全部服务 `0 failures`。
2. warning 仅剩三类，且都能解释：
- `Missing authentication`：管理员端点返回 403，符合最小权限。
- `Missing test data`：状态链依赖已有资源，随机样本命中 404。
- `Schema validation mismatch`：实现层业务校验比 schema 更严格。
3. 无 warning 服务：
- `partner-analytics-service`
- `database-cluster-service`

对应日志：
- [`api-gateway-service.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326/api-gateway-service.log)
- [`bike-inventory-service.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326/bike-inventory-service.log)
- [`ride-service.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326/ride-service.log)
- [`user-service.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326/user-service.log)
- [`payment-service.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326/payment-service.log)
- [`partner-analytics-service.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326/partner-analytics-service.log)
- [`database-cluster-service.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-223326/database-cluster-service.log)

## 5. 契约测试在安全设计中的作用（对应评分：对契约测试在安全设计中作用的理解）

本次 Task D 的核心意义是：把“信任边界设计”从文档声明变成可执行验证。

- 如果边界认证失效，Schemathesis/负向脚本会立即看到 200/201 等异常放行。
- 如果 schema 与实现漂移，Coverage/Fuzzing/Stateful 会给出可复现实例（含重放命令）。
- 如果错误响应不规范（如 HTML 错页），会直接暴露契约不一致。

因此，Schemathesis 在本项目中承担了两层职责：
1. API 正确性回归（contract correctness）
2. 安全边界回归（boundary enforcement）

这也是为什么最终报告不仅要给“通过截图”，还要给“问题-根因-修复-证据”的完整链路。补充详单见：[`docs/openapi-debugging-issues.md`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/docs/openapi-debugging-issues.md)。
