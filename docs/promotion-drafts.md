# Promotion Drafts — 掘金 / HN / Reddit

仓库创建满 1 天、≥10 commits 后再铺内容（awesome-dsh-plugin 门槛同时也是「首个开源」心智的窗口）。
所有 `<owner>` / `skill-dag` 链接发布前替换为真实用户名。

---

## 1. 掘金（中文主流量）— 技术文

标题：《复刻腾讯 GraSP：把散文技能零标注编译成可执行 DAG，我踩的 4 个坑》

正文骨架（完整成文后发布，附 repo 链接 + demo 图）：

```
腾讯 2026 年的 GraSP 论文（arXiv:2604.17870）把"技能"编译成类型化
可执行 DAG，论文没有开源。我基于 spec 文档把它复刻了出来，并且接进了
DeepSeek Harness 的真实 LLM 和真实技能库——不需要给技能写任何标注。

核心思路（120 秒版）：
1. 记忆条件化检索：Eq.1/2 融合语义相似度与历史成功轨迹，低置信回退 ReAct
2. 联合谓词推断：一次 LLM 调用给全部技能生成共享词汇表的 pre/eff，
   解决"散文技能没有形式化签名"的问题——这就是零标注的来源
3. goal-aware 提议：把目标谓词喂给 proposer，让它绑定参数使 effect 精确匹配目标
4. 类型化 DAG：state/data/order 三类边 + 解环 + 四约束 + 拓扑排序，
   执行时 strict/soft 验证，失败用 5 个有界修复算子局部修补（InsertPrereq 等）

我踩的 4 个坑（正文展开，每个都有真实代码教训）：
- 坑 1：scope 拿不到会话技能 → 需要用 exec.agent 作为 scope key
- 坑 2：逐技能推断谓词会互相矛盾 → 必须联合推断、共享词汇表
- 坑 3：proposer 不了解目标就绑定参数 → DAG 永远"目标不可达"，
  必须把 goal 谓词传给 proposer
- 坑 4：client 端 host.call 缺 session 上下文 → 从工具卡片 props 显式传 sessionId

数字对照（与论文完全一致）：
- 空记忆检索 c_ret=0.4831 → 记录后 0.9009 → 无关任务 0.3248（回退 ReAct）
- 修复算子：Rebind / InsertPrereq / Substitute / Rewire / Bypass
- 超参对齐论文 Appendix C.1；w/b 为自定经验值（论文未公开）

形态：零依赖 npm 核心包 skill-dag + DSH 插件 skill-dag-dsh
（聊天里说一句任务 → 工具卡片直接渲染可拖拽 SVG DAG）

诚实边界：unofficial reproduction；LLM 推断谓词是符号性的 best-effort；
检索是 token Jaccard 而非 embedding；DAG 假设无环。

仓库：https://github.com/<owner>/skill-dag
npm：https://www.npmjs.com/package/skill-dag
论文：https://arxiv.org/abs/2604.17870
```

## 2. Hacker News — Show HN

标题：
Show HN: First open-source implementation of Tencent's GraSP (skills → typed DAG compiler)

正文：

```
Tencent's GraSP paper (arXiv 2604.17870, 2026) compiles skills into
typed executable DAGs with memory-conditioned retrieval and verified
execution. The paper ships no code, so I reproduced it from the spec
and wired it into DeepSeek Harness's real LLM + real skill registry.

What it does:
- Type "brainstorm a new feature design then write tests for it" in chat
- The plugin compiles your actual session+workspace skills into a DAG
  (state/data/order edges) with NO manual annotation — predicates are
  jointly LLM-inferred over a shared vocabulary
- Renders as a draggable SVG right in the tool card
- Node verification (strict/soft) + 5 bounded repair operators
- Confidence routing: low confidence falls back to ReAct

Numbers match the paper: c_ret 0.4831 (empty memory) → 0.9009 (after
recording) → 0.3248 (unrelated task, react-fallback).

Honest caveats: unofficial reproduction; LLM-inferred predicates are
symbolic best-effort (formal compilation shines on hand-consistent
skill libraries, like the paper's ALFWorld); retrieval is token
Jaccard, not embeddings.

Two forms:
- skill-dag: zero-dependency npm core package (any harness can reuse)
- skill-dag-dsh: DSH plugin bundle (dsh plugin add)

Repo: https://github.com/<owner>/skill-dag
npm:   https://www.npmjs.com/package/skill-dag
```

## 3. Reddit — r/MachineLearning + r/LocalLLaMA

标题（r/MachineLearning）：
[P] First open-source reproduction of Tencent's GraSP: compile skills into typed DAGs without annotations

正文：

```
Tencent's GraSP (2026, arXiv 2604.17870) treats agent skills as typed
operators (preconditions/effects) and compiles them into executable
DAGs with memory-conditioned retrieval + verified execution. No
official code was released — this is a faithful reproduction built
from the spec, integrated with a real LLM and the harness's real
skill registry (47 skills in our workspace, zero annotation needed).

Key parts:
- Memory-conditioned retrieval (Eq.1/2) with calibrated confidence
- Joint LLM inference of skill predicates over a shared vocabulary
  (this is what removes the manual-annotation requirement)
- Goal-aware proposing that binds arguments so effects match the goal
- Typed DAG with state/data/order edges, cycle handling, 4 constraints
- strict/soft node verification + 5 bounded local repair operators
- Confidence routing with ReAct fallback

Reproduced numbers: c_ret 0.4831 → 0.9009 → 0.3248 (matches paper).

Honest limits: unofficial; inferred predicates are symbolic best-effort;
Jaccard-based retrieval (embedding is an easy swap point).

Zero-dep npm core: https://www.npmjs.com/package/skill-dag
DSH plugin + demo: https://github.com/<owner>/skill-dag
```

---

## 发布节奏（2-3 周窗口内）

| 时间 | 动作 |
|---|---|
| Day 0 | GitHub 建仓 + topics（grasp, llm-agent, skill, dag, planning, deepseek-harness, dsh-plugin）+ README 徽章换真实用户名 + demo 图 |
| Day 0 | npm publish skill-dag → `npm view skill-dag` 验证 |
| Day 1 | 插件构建验证通过后：npm publish skill-dag-dsh |
| Day 1 | awesome-dsh-plugin PR（条目 + CI 通过；仓库已满 1 天、≥10 commits、dsh-plugin topic） |
| Day 1-3 | 掘金技术文 + HN Show HN + Reddit 两帖，全部带 repo 链接 |
| Week 2 | 知乎/V2EX 提问式帖 + DSH 社区（Discord/forum） |
| Week 2-3 | 复盘：star / download / PR 合并情况，补 demo GIF、对比表 |

验收（发布 2 周）：stars > 50、npm downloads > 200、awesome-dsh-plugin 合并。
