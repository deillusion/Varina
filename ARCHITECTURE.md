# Varina-Grounded architecture

主产品是 Agent，不是 workflow。依赖方向如下：

```text
Web / CLI / MCP
       |
       v
AgentService ── SessionStore
       |
       v
AgentSession (conversation + bounded tool loop)
       |                    \
       v                     v
CodebaseHost          Post-ReAct Varina stage
       |                     |
       v                     v
NodeFsHost       Gate → Baseline extraction → Decomposition → Subproblem answers
                             |
                             v
                      Exploration ReAct
                       /     |      \
          Read/Glob/Grep   Diverge   UpdateBoardItem
                            |            |
                       Seats → Dedup     +→ FactLedger
                            |            |
                            +→ MeetingBoard
                             |
                             v
                    Finish → tool result
                              |
                              v
                   Main Agent tool-loop resume
```

## Agent layer

`AgentService` 管理会话创建、单会话互斥、取消、事件与进程中断恢复。持久化状态不含 API Key。

`AgentSession` 保持以下不变式：

1. 当前 user 消息不被动态状态改写；观点板、事实与文件清单作为独立受信 system state 注入。
2. 工具调用与结果按唯一 ID 1:1 配对；重复 ID 不重复执行。
3. 只有当前用户消息包含明确写入意图时，`Edit / Write` 才能通过本地门控。
4. 工具续轮受 `maxToolIterations` 与 `AbortSignal` 限制。
5. 文件正文是待分析的不可信内容，不能改变工具权限。
6. 工具结果进对话前必须过体积闸门：单条超限或单轮合计超预算的结果落盘，对话内只保留 `persisted_path` 与预览，且配对用的 `id / name / ok` 必须原样保留。
7. Varina 开关不得改变普通 ReAct 的 prompt、工具、context 或第一份回答；深度探索只在常规回答落盘后启动。探索完成后，AgentSession 把真实运行参数与结果拼接为一条合成的 `assistant tool_call → tool result` 历史，再以 `roles.main` 和普通工具集继续主 Agent 循环。
8. `/init` 通过一次性 prompt overlay 和专用工具集运行；普通轮次不携带初始化协议或 `InitProject` 工具。

## Context budget

`src/agent/tool_result_budget.mjs` 是唯一的体积闸门实现，阈值对标 Claude Code 的 `toolLimits.ts` / `toolResultStorage.ts`：

- 单条命中行 500 字符（Grep 侧裁剪，返回 `line_chars` / `truncated`）。
- 单条结果 `Grep` 20,000 字符、其余 50,000 字符；单轮合计 200,000 字符。
- 超限不是截断而是落盘 + 2,000 字符预览，落盘走 `Host.persistToolResult`，因此 `NodeFsHost` 与 `MemoryHost` 行为一致。
- 落盘目录位于工作区的 `.varina` 下，运行时数据位于 `.varina/data`，`listFiles` / `grep` 默认跳过 `.varina`，既避免自己再被检索命中，又让模型能用 `Read` 取回原文。

## Retry policy

`src/retry_policy.mjs` 是统一的重试判据：带 HTTP status 的错误走白名单（408/409/429/5xx），其余（含 400）立即失败；不带 status 的本地解析/校验失败才重试，并且只有它才允许追加“只修复 JSON”的提示。模型调用通过 `ModelGateway` 执行。

## Host layer

`NodeFsHost` 是所有工作区访问的唯一端口实现：

- 路径先做词法边界检查，再用 `realpath` 防止 symlink/junction 越界。
- 原始字节用于 SHA-256、BOM 与换行检测；模型看到的是去 BOM、统一 `\n` 的文本视图。
- `expectedHash` 防止读取后被外部修改的文件遭覆盖。
- 覆盖前先备份原始字节；备份索引和目标写入都使用临时文件 + rename。
- `grep` 默认把命中行裁到 500 字符并标注 `line_chars`；单文件大小上限之外，还限制单行宽度，避免“整个文件就是一行”的数据文件一次命中就搬走兆字节。
- `persistToolResult` 是超限结果的落盘出口，写入 `.varina/tool-results/`（模型可用 `Read` 取回，`listFiles` 不会再检索到）。
- 核心逻辑不调用 shell、Git 或 native grep。

`MemoryHost` 实现相同端口，用于离线测试与可重复模拟。

### Workspace and environment injection

`AgentService` 的工作区入口通过 `workspaceHost` 注入，与处理文件内容的 `hostFactory` 分开：

- `root`：允许的工作区根标识，可为本地路径或由适配器定义的虚拟标识。
- `init()`：初始化并验证根工作区；可设置 `realRoot` 为规范化根标识。
- `resolve(requested)`：将指定工作区解析成规范标识，省略参数时使用根工作区；适配器负责访问权限及边界检查。
- `browse(requested)`：返回 `{ root, current, parent, directories }`，目录项为 `{ name, path, hidden }`。

默认 `NodeWorkspaceHost` 保留本地路径、目录与 symlink/junction 边界检查。服务本身不再直接调用 `realpath / stat / readdir` 或解释工作区路径。使用虚拟工作区时，应同时注入 `store / configLoader / hostFactory / gatewayFactory / decisionGatewayFactory`，避免使用本地默认实现。

`configLoader(root, mode)` 返回可直接运行的配置：`models` 是接入方已筛选的可用模型列表，`roles` 和 `seats` 只引用该列表中的 ID。内核仅检查模型 ID 和引用关系，不检查 API Key、读取凭据环境变量、筛除模型或重新分配角色和席位。自定义网关无需提供 `apiKey / apiKeyEnv / isKeyless` 等默认供应商字段。默认 `loadNodeAgentConfig` 在 Node 接入层加载本地配置、按凭据执行现有筛选与回退，并将筛选后的模型列表交给内核；配置界面仍可查看完整配置及回退预览。

普通轮次与用户确认后继续探索共用会话依赖创建逻辑，两条路径均通过同一组工厂创建文件宿主、模型网关和决策网关，并传递本次运行的取消信号与调用记录回调。拒绝探索不创建这些依赖。

`AgentService` 和 `AgentSession` 接受 `env` 对象，默认 `{}`。工具续轮上限与上下文压缩阈值只读取该对象，不直接读取 `process.env`。服务将同一对象传给普通轮次及确认后继续运行的会话；压缩辅助函数也支持显式传入 `env`。Web、CLI 与 MCP 应用入口传入 `process.env`，保留现有环境变量配置方式。默认模型、Jev 与网络适配器仍管理各自的凭据和代理环境变量；这里的 `env` 用于会话运行参数。

这项拆分针对完整 Node.js 22+ 环境下的宿主能力注入；内置 crypto、events、TLS、child_process 等模块无需移除，也不代表已支持裁剪过的 Node 运行时。

## Varina engine

### Operator injection

`operatorPool` 由宿主经 `AgentService → AgentSession → VaryEngine` 传递。核心 `src/varina/operator_pool.mjs` 只实现字段校验、不可变快照、种子随机数和抽样；Agent、引擎及配置概览均不导入 `src/operators.mjs`。默认算子库由 Web、CLI、MCP 接入层显式注入；`createApp` 和 `startMcpServer` 支持覆盖。直接集成内核时，宿主负责提供算子池，缺省仅允许普通聊天，启动探索报错，不回退或合并内置库。

算子记录为 `{ operator_id, family, name, prompt, enabled? }`，四个字符串字段非空，ID 全池唯一，enabled 缺省 true。可用分类至少三个，每席位仍从不同分类抽三张，随机数算法及抽取顺序保持兼容。服务构造时校验并复制冻结，直接创建引擎也执行同一校验。两条探索启动路径共用服务持有的快照；`ConfigService` 从宿主接收同一快照，避免界面展示与实际分配不一致。

私有库可保存在独立包或仓库，由私有宿主 import 后注入。此接口只分离源码所有权，不提供提示词保密或发布打包机制：默认配置概览包含全池正文，运行中的 checkpoint 保存被分配算子的正文，所选模型也会收到正文。开源发布、许可证选择及私有服务访问控制由发行方另行决定。

### Exploration flow

`VaryEngine` 是普通 ReAct 完成后的可选增量阶段，不暴露给主 Agent 的工具循环。开关开启时，后置 gate 只在任务显然与深度探索无关时请求用户确认；不确定默认启动，确认状态持久化且没有计时超时。真实模式配置 `TYPESAFE_API_KEY` 后，这个 gate 由独立的 Jev System One 决策网关执行：只提交状态与 `START / ASK` 选项并读取概率，不进入聊天模型路由，也不生成用户可见文本；模拟模式、未配置凭据或调用失败时沿用保守的本地/既有回退。

常规回答先由结构化提取器完整解析为基线 MeetingBoard，基线观点标记为 round 0，不受 creative 席位每轮 0–3 条贡献上限影响。ReAct 启动前先拆解子问题并逐题并发回答，将问题和答案要素加入初始观点板。拆解默认 5 席位、最多 3 轮，每席每轮最多 4 题，总共最多 20 题；逐题回答默认每题 2 个回答、每个回答最多 3 个要素。

每轮先由实际纳入 Working Memory 的 `(path, content_hash)` 有序清单计算 `repository_snapshot_id`，再冻结问题、硬约束、有效事实、观点板和 snapshot，生成 `packet_token`。同轮所有席位的公共消息完全一致，席位特有算子位于公共前缀之后。

主体是 `src/varina/react.mjs` 中的独立 ReAct 循环，使用主模型或显式配置的 `roles.exploration`。固定 system prompt 描述调查职责及工具规则；固定初始 user 消息包含原始请求、约束、假设、项目背景、子问题及对应答案形成的 meeting board 和目标轮次。后续只追加 assistant 工具调用及对应 tool 结果，不重新注入当前观点板或事实账本。基线、文件和席位文字均为待分析数据，不改变权限。

ReAct 自主使用 `Read / Glob / Grep` 查找和阅读资料，无写文件工具。`Diverge` 等所有席位完成后，用 Jev 对本轮增量按归并层次去重，每层独立比较并行执行；再把每个保留观点单独与完整冻结 meeting board 比较，所有观点并行判重。Jev 只判断保留或删除，不生成观点文本、合并操作或编号；有实质补充、不同机制或不确定的观点保留，子问题节点与非活跃节点不能作为覆盖答案。单项调用失败只保留该项，并记录降级。候选、各次判重结果与错误保存在 `idea_dedup_records`。增量默认未核查；事实账本里的 unknown/stale 也向席位提供，不能隐藏依赖。

`UpdateBoardItem` 一次调用同时更新观点板和事实账本，省去单独的 RecordFact 调用与模型往返。参数为 `item_id / expected_revision / action / reason / patch`；patch 必须包含 `text` 和 `fact`，delete 也一样。fact 包含 `claim / status / explanation / evidence`，可带待核查主张的 claim_ref 和 search_coverage。confirmed/contradicted/partially_true 必须引用本次 ReAct 实际 Read 过的资料，并重新检查路径、行范围、原文片段和文件哈希。纯设计修改使用 not_applicable；资料不足使用 unknown。证据或参数无效时两份状态都不修改，版本冲突返回当前完整观点。删除只将观点标为 deleted，保留修订历史和事实，后续发散能看到删除原因。

`exploration.rounds` 默认 5（允许 1–5）。提前调用 Finish 会被程序干预并补充发散；达到轮数后再调用 Diverge 返回 ROUND_LIMIT，不运行席位。不会因为连续两轮无增量而提前结束。`exploration.maxReactSteps` 默认 100，步数耗尽、取消或模型失败保留部分结果并标记未完成。目标轮次完成后，探索 Agent 仍需完成必要核查并调用无参数的 `Finish()`。Finish 只关闭探索循环，不提交用户回答、候选方案或依赖清单；普通文本不能代替 Finish。

Finish 后，`AgentSession` 将本轮真实探索参数包成 `Vary` tool call，将当前观点板、当前事实、修改摘要、证据、待核查请求、未解决依赖和降级信息包成对应 tool result。合成历史中的 assistant content 先保留基线回答，再补一句“已形成初步判断、下一步调用 Vary”的动作说明，使调用关系自然；该历史只用于模型上下文，审计记录仍标记其来源为运行时拼接。

tool result 之后重新进入主 Agent 循环，仍使用 `roles.main`、主 Agent system prompt 和普通 `Read / Glob / Grep / Edit / Write` 工具集。主 Agent 可以补充查证，最终回答由它生成；不再调用 `renderVarinaFinal` 或 `varina_delta`。最终回答沿用 `USER_ANSWER_GUIDANCE`，说明影响结论的未知项，但不倾倒内部编号和完整依赖清单。

上下文机械压缩仅处理较早的读取/搜索正文。固定初始消息，以及 Diverge/UpdateBoardItem/Finish 的调用与完整结果不可裁剪；混合批次也整体保护，单条及单轮工具结果预算不得将这些结果换成落盘预览。`exploration.maxContextChars` 默认 1,000,000 字符；保护内容本身达到上限时停止并报告 EXPLORATION_CONTEXT_LIMIT，不删除观点历史继续运行。字符预算是近似上下文估计，不保证供应商 token 限制；供应商拒绝时按既有错误策略保留部分结果。

## Persistence and recovery

会话 JSON 是完整审计记录。常规回答以 `baseline` 保存，主 Agent 消化探索结果后的回答以 `varina_addendum` 保存；后者由主 Agent 生成，而不是探索 Agent 的终稿。Varina checkpoint 写入 `active_varina_runtime`，包含 ReAct 消息、调查步骤、读取凭据、工具执行结果、干预记录、观点修改历史及事实账本；相同工具 ID 和参数不会重复执行。正常 handoff 后沉淀为 `VarinaRunRecord` 并移除运行时容器。进程重启遇到普通 ReAct 或后置 Varina 的运行态会话时将其标记为 `interrupted`，避免自动重复调用；`awaiting_varina_confirmation` 保持可恢复。

模型凭证只存在于运行期配置对象。`AgentSessionStore`、会话导出和模型调用审计均不保存 provider payload 或 API Key。

## Entry points and configuration migration

Web、CLI 与 MCP 均通过 `AgentService` 运行。旧的固定轮次实验 engine、RunService、`/api/runs` 和独立 `mcp_ui.mjs` 工作台已移除；新版探索记录保存在会话的 `varina_runs` 中，与旧 run JSON 无依赖。已有旧 run 文件不会被自动删除。

`src/config.mjs` 在加载和保存时统一规范化配置：将 Chair、Dealer、Dedup 等旧角色选择映射到当前角色集合，移除旧阶段生成参数及成功比例要求。`varina_delta` 仅为旧配置兼容而保留，最终回答已改由主 Agent 续轮生成，运行时不会调用该角色。所有模型均参与可用性回退。MCP 的 `aha_*` 工具名继续作为新版工具的兼容别名。

回归测试位于 `test/`，通过 `npm test` 验证旧配置迁移、模型回退、Web 会话、深度探索和 MCP 协议。
