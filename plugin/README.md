# skill-dag-dsh — GraSP Skill DAG Compiler for DeepSeek Harness

在 DSH 里把**真实技能**（会话 + 工作区）零标注编译成类型化可执行 DAG，以 SVG 直接渲染在对话的工具卡片里。

基于 **GraSP**（Tencent, [arXiv:2604.17870](https://arxiv.org/abs/2604.17870)）——首个开源实现，核心引擎见 npm 包 [`skill-dag`](https://www.npmjs.com/package/skill-dag)。

## 安装

```sh
dsh plugin --profile web add skill-dag-dsh
# 重启 dsh web
```

或从 **设置 → Plugin Market** 搜索 `skill-dag-dsh` 一键安装。

## 使用

安装后直接对模型说一句任务，例如：

> *brainstorm a new feature design then write tests for it*

模型会自动调用 `grasp_compile_task`，把任务编译成技能 DAG，并以**可拖拽的 SVG** 渲染在工具卡片里：

- 节点只显示技能名；**悬停**节点框查看 `args / pre / eff` 详情
- 按住画布可**拖拽平移**
- 顶部显示 `N of M skills kept`、路由模式与置信度

### 可用工具

| 工具 | 作用 |
|---|---|
| `grasp_compile_task` | 自然语言任务 → DAG（推断技能谓词 + 目标 + 提议，零标注） |
| `grasp_compile` | 显式 task/goal/proposal 编译 |
| `grasp_verify` / `grasp_repair` | 节点验证 + 五算子有界局部修复 |
| `grasp_retrieve` / `grasp_record` | 记忆条件化检索 + 记录成功轨迹 |
| `grasp_status` | 接线诊断（真实技能/LLM/推断数） |

## 架构

```
浏览器 client（本包 ./client）         Node host（本包 main）
  tool.call.toolview: 渲染 SVG DAG   ←── grasp_compile_task 等模型工具
                                            │ 依赖 skill-dag 核心
                                            └── ctx.llm / ctx.skills / ctx.agents
```

- **Host**（`src/index.ts`）：从 `skill-dag` 导入核心引擎，接 DSH 真实 LLM（`agentDefaultModel` + `llm.stream`）与真实技能库（`scope` 选会话层、`cwd` 选工作区项目层），注册 7 个模型工具。
- **Client**（`src/client/index.ts`）：纯渲染——工具卡片内的可拖拽 DAG SVG，无 host RPC 依赖。

## 构建与本地验证

```sh
cd plugin
npm install          # 需要 pnpm 在 PATH（DSH 用 pnpm 管理依赖）
npm run build        # → lib/index.js (host ESM) + lib/client.js (lazy-CJS factory)
# 本地装：
dsh plugin --profile web add <本目录>
dsh --profile web --dump-config   # 确认 grasp 行挂载
```

> 构建产物说明：DSH 的 client 模块加载器要求 client bundle 是 `window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS closure factory。官方构建 preset 未发布为 npm 包，本包用 tsdown + `scripts/normalize-client-banner.mjs` 复刻该格式（参照 dsh-market 的做法）。

## 已知限制

- 散文技能的谓词由 LLM 联合推断（共享词汇表），是符号性的、best-effort；GraSP 形式化编译在手写一致谓词的技能库上价值最大。
- 检索用 token Jaccard 近似，非 embedding。
- DAG 假设无环。

## License

MIT
