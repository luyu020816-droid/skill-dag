# skill-dag · GraSP Skill DAG Compiler for DeepSeek Harness

> 把扁平技能编译成**类型化可执行 DAG**（state/data/order 三类因果边），带节点验证、有界局部修复、记忆条件化检索与置信度路由——**DSH 真实 LLM 驱动，零手工标注**。

[![npm](https://img.shields.io/npm/v/skill-dag)](https://www.npmjs.com/package/skill-dag)
[![license](https://img.shields.io/github/license/yourname/skill-dag)](LICENSE)
[![stars](https://img.shields.io/github/stars/yourname/skill-dag?style=flat)](https://github.com/yourname/skill-dag)

**首个开源的 [GraSP](https://arxiv.org/abs/2604.17870)（Tencent 2026）复刻实现**，以 DeepSeek Harness 插件 + 零依赖 npm 核心包两种形态交付。

---

## 一图流

你在聊天里说一句任务，AI 提取任务 → 联合推断技能谓词（共享词汇表）→ 目标复用 effect → goal-aware 提议 → 编译出图：

```
src ──→ brainstorming ──→ snk
  │        (eff: design_defined, ready(...))
  └───→ tdd ──────────→ snk
           (eff: failing_test_written, test_passing)
PLAN: [brainstorming → tdd]
```

（SVG 可拖拽；节点悬停显示 args/pre/eff 详情）

## 为什么值得 star

| 亮点 | 说明 |
|---|---|
| **首个 GraSP 开源实现** | 论文无官方代码；本仓库精确复现其架构与数字（c_ret 0.4831→0.9009→0.3248、InsertPrereq 有界修复） |
| **零标注桥** | 联合推断让散文技能共享一套谓词词汇表——**任何人的技能库无需写 grasp: frontmatter**，直接可编译 |
| **真集成** | 接 DSH 真实 LLM（`llm.stream`）+ 真实技能库（会话+工作区，scope+cwd）+ 工具/槽位/内联 SVG |
| **双形态交付** | ① DSH 插件（市场可装）② `skill-dag` 零依赖 npm 包（别的 harness 可复用） |
| **可复现** | 18 项回归断言全过，`npm test` 一键跑 |

## 快速开始

### 作为 DSH 插件（聊天即用）

```sh
dsh plugin --profile web add skill-dag-dsh   # 或从 dsh-market 安装
```

然后直接在对话里说：*"brainstorm a new feature design then write tests for it"* —— DAG 以 SVG 直接渲染在工具卡片里。

### 作为 npm 核心包

```sh
npm install skill-dag
```

```js
const { createGraspCore, memoryStore, manifestSource, createProposer } = require('skill-dag')
// 见 skill-dag/README.md 的完整示例
```

## 架构

```
┌─────────────────────────────────────────┐
│ Layer 3  Client — SVG DAG 可视化（可拖拽） │
└──────────────┬──────────────────────────┘
               │ host.call JSON RPC
┌──────────────▼──────────────────────────┐
│ Layer 2  Adapter — ctx.skills/llm/       │
│           storage → SkillSource/Proposer/│
│           Store 接口（换 harness 只改这层） │
└──────────────┬──────────────────────────┘
               │ 依赖注入
┌──────────────▼──────────────────────────┐
│ Layer 1  skill-dag 核心（零 harness 依赖） │
│   绑定→过滤→推边→解环→四约束→拓扑→布局      │
│   验证(strict/soft) + 5算子本地修复        │
└─────────────────────────────────────────┘
```

## 仓库结构

```
├── skill-dag/          # 零依赖核心 npm 包（createGraspCore + adapters）
│   ├── index.js        # 核心引擎
│   ├── index.d.ts      # TypeScript 声明
│   └── test/verify.js  # 18 项回归断言（npm test）
├── plugin/             # DSH 插件 bundle（cordis.patch.yml + client）
│   └── …               # 见 plugin/README.md
├── grasp-spec.md       # 完整复刻规格（自包含，可独立复刻）
└── LICENSE             # MIT
```

## 论文对齐

GraSP 四阶段全部实现：**记忆条件化检索**（Eq.1/2 + 校准置信度）→ **DAG 编译**（typed edges + 解环 + 目标完备）→ **验证执行**（strict/soft 双档）→ **置信度路由**（低置信回退 ReAct）。超参数对齐 Appendix C.1；置信度权重 w/b 为自定经验值（论文未公开）。

## 诚实声明

- 本项目为 **unofficial reproduction**，未见官方代码（论文仅附录 F 提到 `src/esg.py` 孤立路径）。
- LLM 推断的谓词是**符号性**的，未绑定可观测状态；GraSP 形式化编译在**手写一致谓词**的技能库上价值最大（如 ALFWorld），散文技能 + LLM 推断是 best-effort。
- 检索用 token Jaccard 近似，非 embedding（扩展点：注入 `similarity` 函数）。
- DAG 假设无环；循环任务不在范围（论文 §6 自身边界）。

## Roadmap

- [x] 核心引擎 + 验证 + 五算子修复 + 检索/路由
- [x] DSH 真实 LLM + 真实技能库（会话+工作区，scope+cwd）
- [x] 聊天内联 SVG + 可拖拽可视化
- [ ] 独立 npm 核心包发布（skill-dag ✓ 就绪）
- [ ] DSH 插件 bundle 发布（cordis.patch.yml + dsh.client）
- [ ] LangGraph / MCP adapter（复用同一核心）
- [ ] embedding 检索替换 tokenSim
- [ ] 复现论文一个消融结论（局部修复 vs 全局重规划恢复率）

## License

MIT
