# GraSP 插件复刻与灵活化改造

> 本文档自包含：另一个 DSH 只读本文档即可复刻出插件。相比初版，本版的核心变化是**把编译引擎从 DSH 里抽出来**，让同一份核心既能跑在 DSH 插件里，也能作为独立包被别的 harness 使用。
> 论文依据：[GraSP: Graph-Structured Skill Compositions for LLM Agents](https://arxiv.org/abs/2604.17870)（Tencent，arXiv:2604.17870，2026-04-20）。**官方无开源实现**，本项目为 unofficial reproduction。
> 定位一句话：把扁平技能编译成带类型化依赖边（state/data/order）的可执行 DAG，带节点验证、有界局部修复、记忆条件化检索与置信度路由。

---

## 0. 相比初版改了什么（改造清单）

初版的四个硬伤，与本版的对应处理：

| 初版问题 | 本版处理 | 落在哪一节 |
|---|---|---|
| 技能库是手写玩具 manifest，用户装完只能看 apple demo | 抽象出 **SkillSource 接口**，内置 3 个实现：`manifest`（手写 JSON，保留用于测试）、`dshSkills`（读 `ctx.skills` 真实技能库）、`frontmatter`（从 SKILL.md frontmatter 抽 precondition/effect） | §2.1、§3 `createSkillSource` |
| 无真实 LLM 集成，proposal 靠手动注入 | 抽象出 **Proposer 接口**：`explicit`（手动注入，保留）、`retrieval`（top-M 兜底）、`llm`（真实 LLM 提议节点，走注入的 `llm.stream`） | §2.2、§3 `createProposer` |
| plan 与记忆均为进程内，重启即丢 | 抽象出 **Storage 接口**：`memory`（进程内）、`kv`（注入 `ctx.storage`），记忆 ℳ 与 plan 均可持久化 | §2.3、§3 `createStore` |
| 绑定单一 harness，受众被缩小 | **三层拆分**：核心引擎零 harness 依赖（§3）→ 薄 adapter 对接 DSH（§4）→ Client 可视化（§5）。核心可直接发 npm 包 | §1、§3、§4 |

另外补齐的灵活性：所有论文超参数（τ_low / τ_high / L_max / E_max / λ / η / k / M / h / R_max / P_max）全部提到 config，可在运行时覆盖；五个修复算子改为**注册表**，可增删算子与调整尝试顺序；验证器支持 `strict`（谓词集合判定）与 `soft`（效果不可观测时回退 LLM 软验证）两档。

---

## 1. 架构：三层，逐层可替换

```
┌─────────────────────────────────────────────────────┐
│ Layer 3  Client（可视化）                            │
│   SVG DAG 浮层 · 纯展示 · 只依赖 host.call 的 JSON   │
└─────────────────────────────────────────────────────┘
                        ↕  Host↔Client RPC
┌─────────────────────────────────────────────────────┐
│ Layer 2  Adapter（对接具体 harness）                 │
│   把 ctx.skills / ctx.llm / ctx.storage 适配成       │
│   SkillSource / Proposer / Storage 三个接口          │
│   → 换 harness 只需重写这一层（约 80 行）             │
└─────────────────────────────────────────────────────┘
                        ↕  依赖注入
┌─────────────────────────────────────────────────────┐
│ Layer 1  Core（编译引擎，零 harness 依赖）            │
│   createGraspCore({ params, skillSource,            │
│                     proposer, store, operators,     │
│                     verifier })                     │
│   纯逻辑：绑定→过滤→推边→解环→四约束→拓扑→布局        │
│   可直接 import 进 node / 发 npm 包 / 写单测          │
└─────────────────────────────────────────────────────┘
```

**关键设计决策（复刻时必须保持）**：

1. Core 里**不出现** `harness`、`ctx`、`React` 任何标识符。它只吃普通对象与函数。这是「能否发独立包」的判定标准。
2. 插件 = 编排 + 验证 + 修复的辅助层，agent = 执行器。插件产出 plan，agent 逐节点执行后回传状态快照给 verify/repair。
3. verifier 默认 `strict` 档**禁裸 JS eval**，用受限谓词集合判定（`precondition ⊆ before` 且 `effect ⊆ after`）；`soft` 档才调 LLM。
4. data 边只在已有 state 边（effect∩precondition）基础上派生，只绑定共享谓词 arg，避免反向成环。

---

## 2. 三个可插拔接口的契约

Core 通过这三个接口与外界交互。每个接口都有「零依赖默认实现」，因此 Core 单独跑得起来（可写单测），接上 harness 后能力增强。

### 2.1 SkillSource —— 技能从哪来

```js
// 契约
{
  // 返回技能定义数组；每个技能：
  //   { id, name, params[], precondition[], effect[], args?, verifier? }
  list: async () => Skill[],
  // 可选：单取
  get: async (id) => Skill | null
}
```

三个内置实现：

| 实现 | 数据来源 | 用途 |
|---|---|---|
| `manifest(obj)` | 手写 JSON 的 `skills[]` | 单测与 demo，**不再是唯一形态** |
| `dshSkills(ctx)` | `ctx.skills.list()` / `snapshot()` / `get(name)` | 接 DSH 真实技能库 |
| `frontmatter(files)` | SKILL.md 的 YAML frontmatter | 从真实 skill 文件抽 precondition/effect |

`frontmatter` 约定的 SKILL.md 头部（这是让真实技能可编译的关键，也是本次改造的 P0）：

```yaml
---
name: clean-object
description: Clean an object under running water
grasp:
  params: [object]
  precondition: ["holding(object)", "at(agent,sink)"]
  effect: ["clean(object)"]
---
```

若某个 SKILL.md 没有 `grasp:` 段，`frontmatter` 实现应**跳过并计数**，在编译结果里回传 `skipped: [{name, reason}]`，而不是静默丢弃——否则用户不知道为什么自己的技能没进图。

### 2.2 Proposer —— 谁决定图里放哪些节点

```js
// 契约
{
  // 返回 [{ skill, args[], confidence? }]
  propose: async ({ task, skills, retrieval }) => Proposal[]
}
```

| 实现 | 行为 | 何时用 |
|---|---|---|
| `explicit(list)` | 直接返回手动注入的 proposal | 复现论文实验、写单测 |
| `retrieval()` | 取检索 top-M，args 用技能自带默认值 | 无 LLM 时的兜底（初版的实际行为） |
| `llm(llmClient)` | 调 LLM 提议节点与参数绑定 | **论文的真实链路**，端到端时用 |

`llm` 实现的注入形式（不在源码里写死 provider / model / 凭据）：

```js
const llmProposer = createProposer('llm', {
  // llmClient 只需满足：complete({ prompt, temperature }) => string
  llmClient: {
    complete: async ({ prompt, temperature }) => {
      const out = await llm.stream({ messages: [{ role: 'user', content: prompt }], temperature: temperature })
      return out.text
    }
  },
  // 解析失败时的退路：降级到 retrieval，而不是抛错中断
  fallback: 'retrieval'
})
```

**LLM 输出必须做 schema 校验后才进图**：只接受 `[{skill, args}]` 形状，`skill` 必须在 skills 列表里，`args` 长度须与 `params` 一致；任一不满足则整条丢弃并计入 `rejected`。这是防止 LLM 幻觉污染确定性编译的唯一防线。

### 2.3 Storage —— plan 与记忆存哪

```js
// 契约
{
  get: async (key) => any | null,
  set: async (key, value) => void,
  del: async (key) => void,
  keys: async (prefix) => string[]
}
```

| 实现 | 行为 |
|---|---|
| `memoryStore()` | `Map` 进程内，重启即丢（初版行为，保留作默认） |
| `kvStore(ctx.storage)` | 走 harness 的 `ctx.storage` / `storageDomain` / `sessionPersistence`，跨会话存活 |

存两类 key：`plan:<planId>`（编译产物）与 `memory:episodes`（记忆 ℳ 的 episode 数组）。记忆持久化后，Eq.1/2 的检索才在真实使用中成立——这是论文卖点能否落地的分界线。

---

## 3. Core 源码（零 harness 依赖，可直接发 npm 包）

**文件建议：`src/core/index.js`。** 判定标准：本节代码里搜不到 `harness`、`ctx`、`React`。

### 3.1 默认参数（全部来自论文 Appendix C.1 Table 3，可运行时覆盖）

```js
const DEFAULT_PARAMS = {
  tauLow: 0.40,      // < 此值 → react-fallback
  tauHigh: 0.65,     // > 此值 → full-dag
  lMax: 3,           // 单次修复补丁最多新增节点数
  eMax: 5,           // 单次修复补丁最多新增边数
  lambda: 0.5,       // Eq.1 直接语义 vs 记忆的混合权重
  eta: 0.7,          // Eq.2 learned vs 历史成功率的权重
  k: 5,              // 取多少条相关记忆
  m: 5,              // 交给编译的 top-M 技能数
  h: 2,              // 修复邻域半径（hop）
  rMax: 2,           // 每节点修复预算
  pMax: 1,           // 每 episode 全局重规划次数
  confWeights: [1.2, 1.0, 0.8, 1.8],  // 置信度特征权重 w
  confBias: -2.0,                      // 置信度偏置 b
  verifyMode: 'strict',                // 'strict' | 'soft'
  operatorOrder: null                  // null=用类型默认顺序；否则显式指定
}
```

### 3.2 检索层（Eq.1 / Eq.2）

```js
const STOP = new Set(['a','an','the','and','it','to','for','of','with','is','are','was','were','be','been','this','that','these','those','we','you','he','she','they','do','does','did','have','has','had','but','or','not','can','could','will','would','should','shall'])

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 0 && !STOP.has(t))
}
function tokenSim(a, b) {
  const ta = new Set(tokenize(a)), tb = new Set(tokenize(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  ta.forEach(t => { if (tb.has(t)) inter++ })
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}
function skillText(s) {
  return [s.id, s.name, (s.description || ''), (s.effect || []).join(' ')].join(' ')
}
function kl(p, q) {
  let s = 0
  for (let i = 0; i < p.length; i++) if (p[i] > 0) s += p[i] * Math.log(p[i] / q[i])
  return s
}
function jsdScore(p, q) {
  const m = p.map((v, i) => (v + q[i]) / 2)
  return 0.5 * kl(p, m) + 0.5 * kl(q, m)
}
function predName(p) { const m = /^([a-z_]+)\(/.exec(p); return m ? m[1] : p }

function goalCover(topM, byId, goal) {
  if (!goal.length) return 1
  const names = new Set()
  topM.forEach(id => { (byId[id].effect || []).forEach(e => names.add(predName(e))) })
  let hit = 0
  goal.forEach(g => { if (names.has(predName(g))) hit++ })
  return hit / goal.length
}

// episodes 由外部传入（可能来自持久化 store），不再是闭包里的 MEMORY 数组
function retrieve({ skills, goal, task, episodes, params }) {
  const P = params
  const byId = {}
  skills.forEach(s => { byId[s.id] = s })

  const dirRaw = skills.map(s => tokenSim(task, skillText(s)) + 0.001)
  const dirSum = dirRaw.reduce((a, b) => a + b, 0)
  const pDir = dirRaw.map(v => v / dirSum)

  const scored = (episodes || []).map((m, i) => ({ i, rho: tokenSim(task, m.task) }))
  scored.sort((a, b) => b.rho - a.rho)
  const topk = scored.slice(0, P.k).filter(r => r.rho > 0)
  const rhoBar = topk.length ? topk.reduce((a, r) => a + r.rho, 0) / topk.length : 0

  const memRaw = skills.map(s => {
    let acc = 0
    topk.forEach(r => {
      acc += r.rho * (episodes[r.i].trajectory || []).filter(x => x === s.id).length
    })
    return acc + 0.001
  })
  const memSum = memRaw.reduce((a, b) => a + b, 0)
  const pMem = memRaw.map(v => v / memSum)

  let p = pDir.map((v, i) => P.lambda * v + (1 - P.lambda) * pMem[i])
  const pSum = p.reduce((a, b) => a + b, 0)
  p = p.map(v => v / pSum)

  const ranked = skills.map((s, i) => ({ id: s.id, p: p[i] })).sort((a, b) => b.p - a.p)
  const topM = ranked.slice(0, P.m).map(r => r.id)

  const sortedP = p.slice().sort((a, b) => b - a)
  const margin = sortedP.length > 1 ? sortedP[0] - sortedP[1] : (sortedP.length ? sortedP[0] : 0)
  const agree = topk.length ? 1 - jsdScore(pDir, pMem) : 0
  const cover = goalCover(topM, byId, goal)
  const features = [rhoBar, agree, margin, cover]

  const w = P.confWeights
  const z = w[0]*features[0] + w[1]*features[1] + w[2]*features[2] + w[3]*features[3] + P.confBias
  const learned = 1 / (1 + Math.exp(-z))
  const cHist = topk.length ? topk.reduce((a, r) => a + episodes[r.i].success, 0) / topk.length : 0.5
  const cRet = P.eta * learned + (1 - P.eta) * cHist

  return {
    skills: topM, p, p_dir: pDir, p_mem: pMem,
    features: { rhoBar, agreement: agree, margin, coverage: cover },
    confidence: cRet,
    mode: route(cRet, P).mode,
    memory: topk.map(r => ({ task: episodes[r.i].task, rho: r.rho, success: episodes[r.i].success }))
  }
}

// 路由阈值改为读 params，不再硬编码 0.40 / 0.65
function route(confidence, params) {
  const c = (typeof confidence === 'number') ? confidence : null
  if (c === null) return { confidence: c, mode: 'full-dag-boosted-repair' }
  if (c < params.tauLow) return { confidence: c, mode: 'react-fallback' }
  if (c > params.tauHigh) return { confidence: c, mode: 'full-dag' }
  return { confidence: c, mode: 'full-dag-boosted-repair' }
}
```

### 3.3 确定性编译核心

```js
function parsePred(p) {
  const m = /^([a-z_]+)\(([^)]*)\)$/.exec(p)
  if (!m) return null
  const args = m[2].split(',').map(s => s.trim()).filter(s => s.length > 0)
  return { name: m[1], args }
}
function predArg(p) {
  const m = /^[a-z_]+\(([^)]*)\)$/.exec(p)
  if (!m) return null
  const inner = m[1].split(',').map(s => s.trim())
  return inner.length === 1 ? inner[0] : null
}

function bindSkill(s, args) {
  const params = s.params || []
  const bind = (p) => {
    let out = p
    params.forEach((pm, i) => {
      const val = args[i]
      if (val === undefined || val === null) return
      out = out.replace(new RegExp('\\b' + pm + '\\b', 'g'), String(val))
    })
    return out
  }
  return {
    id: s.id, name: s.name,
    params: params.slice(), args: (args || []).slice(),
    precondition: (s.precondition || []).map(bind),
    effect: (s.effect || []).map(bind),
    verifier: s.verifier || null
  }
}

function instantiate(skills, proposal, params) {
  const byId = {}
  skills.forEach(s => { byId[s.id] = s })
  const items = (Array.isArray(proposal) && proposal.length)
    ? proposal
    : skills.map(s => ({ skill: s.id, args: s.args || [] }))
  const counts = {}
  const nodes = []
  items.forEach(item => {
    const s = byId[item.skill]
    if (!s) return
    counts[item.skill] = (counts[item.skill] || 0) + 1
    const bid = bindSkill(s, item.args)
    nodes.push({
      id: item.skill + ':' + counts[item.skill],
      kind: 'skill', skill: s.id, name: s.name,
      args: bid.args, params: bid.params,
      precondition: bid.precondition, effect: bid.effect,
      verifier: bid.verifier, status: 'pending',
      confidence: (typeof item.confidence === 'number' ? item.confidence : 1.0),
      repairBudget: params.rMax, repairCount: 0
    })
  })
  return nodes
}

function backwardFilter(nodes, goal, initial) {
  const kept = new Set()
  const produced = new Set(initial || [])
  const needed = new Set((goal || []).filter(g => !produced.has(g)))
  let changed = true
  while (changed) {
    changed = false
    nodes.forEach(n => {
      if (kept.has(n.id)) return
      if (n.effect.some(e => needed.has(e))) {
        kept.add(n.id)
        n.effect.forEach(e => produced.add(e))
        n.precondition.forEach(p => { if (!produced.has(p)) needed.add(p) })
        changed = true
      }
    })
  }
  return { kept, produced, needed }
}

function inferEdges(nodes, orderHints) {
  const edges = []
  const seen = new Set()
  const add = (from, to, type, label) => {
    if (from === to) return
    const k = from + '|' + to + '|' + type + '|' + label
    if (seen.has(k)) return
    seen.add(k)
    edges.push({ from, to, type, label })
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue
      const u = nodes[i], v = nodes[j]
      // state 边：u 的 effect 满足 v 的 precondition
      u.effect.forEach(e => {
        if (v.precondition.indexOf(e) >= 0) add(u.id, v.id, 'state', e)
      })
      // data 边：只在已有 state 关系上派生，且只绑共享谓词 arg（防反向成环）
      v.args.forEach(a => {
        const hit = u.effect.some(e => v.precondition.indexOf(e) >= 0 && predArg(e) === a)
        if (hit) add(u.id, v.id, 'data', a + ' → ' + v.id)
      })
    }
  }
  ;(orderHints || []).forEach(h => add(h.from, h.to, 'order', h.label || 'order'))
  return edges
}

function topoOrder(nodes, edges) {
  const ids = nodes.map(n => n.id)
  const indeg = {}, adj = {}
  ids.forEach(id => { indeg[id] = 0; adj[id] = [] })
  edges.forEach(e => {
    if (!(e.to in indeg) || !(e.from in adj)) return
    adj[e.from].push(e.to); indeg[e.to]++
  })
  const q = ids.filter(id => indeg[id] === 0)
  const order = []
  while (q.length) {
    const id = q.shift()
    order.push(id)
    adj[id].forEach(to => { indeg[to]--; if (indeg[to] === 0) q.push(to) })
  }
  return order.length === ids.length ? order : null
}
function hasCycle(nodes, edges) { return topoOrder(nodes, edges) === null }

function reachable(a, b, nodes, edges) {
  const adj = {}
  nodes.forEach(n => { adj[n.id] = [] })
  edges.forEach(e => { if (e.from in adj && e.to in adj) adj[e.from].push(e.to) })
  const seen = { [a]: true }
  const q = [a]
  while (q.length) {
    const id = q.shift()
    adj[id].forEach(t => { if (!seen[t]) { seen[t] = true; q.push(t) } })
  }
  return !!seen[b]
}

function layoutNodes(nodes, edges) {
  const rank = {}
  nodes.forEach(n => { rank[n.id] = 0 })
  const order = topoOrder(nodes, edges) || nodes.map(n => n.id)
  order.forEach(id => {
    edges.forEach(e => {
      if (e.to === id && e.from in rank) rank[id] = Math.max(rank[id], rank[e.from] + 1)
    })
  })
  const byRank = {}
  Object.keys(rank).forEach(id => { (byRank[rank[id]] = byRank[rank[id]] || []).push(id) })
  Object.keys(byRank).forEach(r => {
    byRank[r].sort()
    byRank[r].forEach((id, i) => {
      const n = nodes.find(x => x.id === id)
      if (n) { n.x = 40 + r * 300; n.y = 30 + i * 116 }
    })
  })
}
```

编译主函数。注意它现在是 `async`（因为 SkillSource / Proposer / Storage 都是异步的），且**不再自己持有技能库**——技能从注入的 source 来：

```js
async function compileWith(deps, { task, proposal, goal, initialConditions, orderHints }) {
  const { params, skillSource, proposer, store } = deps
  const P = params

  const skills = await skillSource.list()
  if (!skills.length) return { ok: false, reason: 'skill source returned no skills' }
  const byId = {}
  skills.forEach(s => { byId[s.id] = s })

  const goalList = goal || []
  const initial = initialConditions || []

  // ---- 检索 + 路由 ----
  let ret = null
  let effectiveProposal = proposal
  if (task && task.length) {
    const episodes = (await store.get('memory:episodes')) || []
    ret = retrieve({ skills, goal: goalList, task, episodes, params: P })
    if (ret.mode === 'react-fallback') {
      return {
        ok: true, dag: null,
        routing: { confidence: ret.confidence, mode: 'react-fallback' },
        retrieval: { skills: ret.skills, features: ret.features },
        reason: 'low retrieval confidence → ReAct fallback'
      }
    }
    if (!Array.isArray(proposal) || !proposal.length) {
      // 走注入的 proposer（可能是 llm / retrieval / explicit）
      effectiveProposal = await proposer.propose({ task, skills, retrieval: ret })
    }
  }

  // ---- 校验 proposal 合法性（防 LLM 幻觉入图）----
  const rejected = []
  if (Array.isArray(effectiveProposal)) {
    effectiveProposal = effectiveProposal.filter(p => {
      const s = byId[p.skill]
      if (!s) { rejected.push({ skill: p.skill, reason: 'unknown skill' }); return false }
      const need = (s.params || []).length
      const got = (p.args || []).length
      if (need !== got) { rejected.push({ skill: p.skill, reason: 'arity ' + got + ' != ' + need }); return false }
      return true
    })
  }

  let nodes = instantiate(skills, effectiveProposal, P)
  if (!nodes.length) return { ok: false, reason: 'no skill nodes', rejected }

  // ---- 反向可达过滤 ----
  const f = backwardFilter(nodes, goalList, initial)
  const keptCount = nodes.filter(n => f.kept.has(n.id)).length
  nodes = nodes.filter(n => f.kept.has(n.id))
  if (!nodes.length) return { ok: false, reason: 'goal unreachable: no skill covers goal', rejected }

  // ---- 推边 + 解环（硬边不可动，软 order 边按置信度递增试加）----
  let edges = inferEdges(nodes, orderHints)
  const hard = edges.filter(e => e.type !== 'order')
  const soft = edges.filter(e => e.type === 'order')
  if (hasCycle(nodes, hard)) return { ok: false, reason: 'cycle among hard edges', rejected }
  edges = hard.slice()
  soft.slice().sort((a, b) => (a.confidence || 0) - (b.confidence || 0)).forEach(e => {
    if (!hasCycle(nodes, edges.concat([e]))) edges.push(e)
  })

  // ---- 加 src / snk 结构节点 ----
  const src = { id: 'src', kind: 'src', skill: null, name: 'START', args: [], precondition: [], effect: initial.slice(), status: 'verified', confidence: 1 }
  const snk = { id: 'snk', kind: 'snk', skill: null, name: 'GOAL', args: [], precondition: goalList.slice(), effect: [], status: 'pending', confidence: 1 }
  const all = [src].concat(nodes).concat([snk])

  const hardIn = {}
  all.forEach(n => { hardIn[n.id] = 0 })
  edges.forEach(e => { if (e.to in hardIn) hardIn[e.to]++ })
  nodes.forEach(n => { if (hardIn[n.id] === 0) edges.push({ from: 'src', to: n.id, type: 'order', label: 'start' }) })
  const hasOut = {}
  nodes.forEach(n => { hasOut[n.id] = false })
  edges.forEach(e => { if (e.from in hasOut) hasOut[e.from] = true })
  nodes.forEach(n => {
    if (!hasOut[n.id] || n.effect.some(e => goalList.indexOf(e) >= 0)) {
      edges.push({ from: n.id, to: 'snk', type: 'order', label: 'goal' })
    }
  })

  // ---- 四约束 ----
  if (hasCycle(all, edges)) return { ok: false, reason: 'cycle after structural edges', rejected }
  if (!reachable('src', 'snk', all, edges)) return { ok: false, reason: 'src to snk unreachable', rejected }
  const uncovered = goalList.filter(g =>
    !(initial.indexOf(g) >= 0 || nodes.some(n => n.effect.indexOf(g) >= 0)))
  if (uncovered.length) return { ok: false, reason: 'goal completeness failed: ' + uncovered.join(', '), rejected }

  const skillEdges = edges.filter(e => e.from !== 'src' && e.to !== 'snk')
  const plan = topoOrder(nodes, skillEdges)
  if (!plan) return { ok: false, reason: 'no valid topological order', rejected }
  layoutNodes(all, edges)

  const planId = 'plan_' + (await nextSeq(store))
  const dag = {
    planId, task: task || '',
    goal: goalList, initial_conditions: initial,
    nodes: all, edges, plan,
    routing: ret ? { confidence: ret.confidence, mode: ret.mode } : route(null, P),
    retrieval: ret ? { skills: ret.skills, features: ret.features } : null,
    filtered: keptCount + ' of ' + skills.length + ' skills kept',
    rejected,
    params: P
  }
  await store.set('plan:' + planId, dag)
  return { ok: true, dag }
}

// planId 序号也持久化，避免重启后 id 撞车
async function nextSeq(store) {
  const cur = (await store.get('meta:seq')) || 0
  const next = cur + 1
  await store.set('meta:seq', next)
  return next
}
```

### 3.4 验证层（双档：strict / soft）

```js
// strict：受限谓词集合判定，禁裸 JS eval
function verifyStrict(node, before, after, initial) {
  const b = before || [], a = after || []
  const missingPre = node.precondition.filter(p => b.indexOf(p) < 0 && (initial || []).indexOf(p) < 0)
  if (missingPre.length) {
    return { pass: false, type: 'precondition', message: 'missing: ' + missingPre.join(', ') }
  }
  const missingEff = node.effect.filter(p => a.indexOf(p) < 0)
  if (missingEff.length) {
    return { pass: false, type: 'postcondition', message: 'effect not observed: ' + missingEff.join(', ') }
  }
  return { pass: true }
}

// soft：效果不可观测时（如"文件内容变好了"这类无法用谓词表达的效果）回退 LLM 软验证
// 仅当 strict 判定为 postcondition 失败、且节点标了 softVerify 才启用
async function verifySoft(node, before, after, llmClient) {
  if (!llmClient) return null   // 无 LLM 则不启用，保持确定性
  const prompt = [
    'Skill: ' + node.name,
    'Expected effect: ' + node.effect.join(', '),
    'State before: ' + (before || []).join(', '),
    'State after: ' + (after || []).join(', '),
    'Did the expected effect actually occur? Answer strictly "YES" or "NO" followed by one short reason.'
  ].join('\n')
  const out = await llmClient.complete({ prompt, temperature: 0 })
  const yes = /^\s*YES/i.test(String(out || ''))
  return { pass: yes, type: 'postcondition', message: 'soft verify: ' + String(out || '').slice(0, 120) }
}

async function verifyNode(deps, dag, nodeId, before, after) {
  const node = dag.nodes.find(n => n.id === nodeId)
  if (!node) return { ok: false, error: 'node not found: ' + nodeId }

  const strict = verifyStrict(node, before, after, dag.initial_conditions)
  if (strict.pass) {
    node.status = 'verified'
    return { ok: true, pass: true, node: node.id, mode: 'strict' }
  }

  // 只有 postcondition 失败 + soft 模式 + 节点允许，才尝试软验证
  if (deps.params.verifyMode === 'soft' && strict.type === 'postcondition' && node.softVerify !== false) {
    const soft = await verifySoft(node, before, after, deps.llmClient)
    if (soft && soft.pass) {
      node.status = 'verified'
      return { ok: true, pass: true, node: node.id, mode: 'soft' }
    }
  }

  node.status = 'failed'
  return {
    ok: true, pass: false, mode: 'strict',
    event: { nodeId, type: strict.type, message: strict.message, state: before || [] }
  }
}
```

### 3.5 修复算子：改为注册表，可增删可换序

初版把五个算子写死在 `if/else` 链里，且尝试顺序硬编码。本版改为**注册表 + 可配置顺序**，第三方可注册自己的算子而不改核心代码。

```js
// 每个算子签名统一：(context) => patch | null
//   context = { dag, node, event, library, params, helpers }
//   返回 null 表示该算子不适用，交给下一个
const BUILTIN_OPERATORS = {
  Bypass({ dag, node, event, helpers }) {
    const dreq = helpers.downstreamReq(dag, node)
    const state = event.state || []
    if (!dreq.every(p => state.indexOf(p) >= 0)) return null
    node.status = 'bypassed'
    return { operator: 'Bypass', patch: { addedNodes: 0, addedEdges: 0, bypassed: node.id }, bounded: true }
  },

  Rebind({ node, event, library, helpers }) {
    if (!event.args || !Array.isArray(event.args)) return null
    const s = library.find(x => x.id === node.skill)
    if (!s) return null
    const bid = helpers.bindSkill(s, event.args)
    node.args = bid.args
    node.precondition = bid.precondition
    node.effect = bid.effect
    return { operator: 'Rebind', patch: { rebind: node.id, args: event.args }, bounded: true }
  },

  InsertPrereq({ dag, node, event, library, params, helpers }) {
    const state = event.state || []
    const missing = node.precondition.filter(p =>
      state.indexOf(p) < 0 && (dag.initial_conditions || []).indexOf(p) < 0)
    if (!missing.length) return null

    const addedNodes = []
    for (const p of missing) {
      const cand = library.find(s => (s.effect || []).some(g => {
        const gp = helpers.parsePred(g), cp = helpers.parsePred(p)
        return gp && cp && gp.name === cp.name && gp.args.length === cp.args.length
      }))
      if (!cand) continue
      if (addedNodes.length + 1 > params.lMax) break
      const argMap = helpers.deriveArgs(cand, p)
      let cnt = dag.nodes.filter(n => n.skill === cand.id).length + 1
      const bid = helpers.bindSkill(cand, argMap)
      addedNodes.push({
        id: cand.id + ':' + cnt, kind: 'skill', skill: cand.id, name: cand.name,
        args: bid.args, params: bid.params, precondition: bid.precondition,
        effect: bid.effect, verifier: bid.verifier, status: 'pending',
        confidence: 1, repairBudget: params.rMax, repairCount: 0
      })
    }
    if (!addedNodes.length) return null

    // 先算边数，超界则整批回滚（有界性保证）
    const addedEdges = []
    addedNodes.forEach(an => {
      an.effect.forEach(e => {
        if (node.precondition.indexOf(e) >= 0) addedEdges.push({ from: an.id, to: node.id, type: 'state', label: e })
      })
      addedEdges.push({ from: 'src', to: an.id, type: 'order', label: 'repair' })
    })
    if (addedNodes.length > params.lMax || addedEdges.length > params.eMax) return null

    addedNodes.forEach(an => dag.nodes.push(an))
    addedEdges.forEach(e => dag.edges.push(e))
    return {
      operator: 'InsertPrereq',
      patch: { addedNodes: addedNodes.map(a => a.id), addedEdges: addedEdges.length },
      bounded: true
    }
  },

  Substitute({ dag, node, library, helpers }) {
    const dreq = helpers.downstreamReq(dag, node)
    if (!dreq.length) return null
    const alt = library.find(s =>
      s.id !== node.skill && dreq.every(p => (s.effect || []).indexOf(p) >= 0))
    if (!alt) return null
    node.skill = alt.id
    node.name = alt.name
    node.precondition = (alt.precondition || []).slice()
    node.effect = (alt.effect || []).slice()
    return { operator: 'Substitute', patch: { replacedWith: alt.id }, bounded: true }
  },

  Rewire({ dag, node }) {
    const idx = dag.edges.findIndex(e => e.to === node.id && e.type === 'order')
    if (idx < 0) return null
    dag.edges.splice(idx, 1)
    return { operator: 'Rewire', patch: { removedEdges: 1 }, bounded: true }
  }
}

// 按失败类型的默认尝试顺序（论文的经验排序），可被 params.operatorOrder 覆盖
const DEFAULT_ORDER = {
  precondition:  ['InsertPrereq', 'Rebind', 'Substitute', 'Rewire', 'Bypass'],
  postcondition: ['Substitute', 'Rebind', 'Rewire', 'Bypass', 'InsertPrereq'],
  execution:     ['Substitute', 'Rebind', 'Rewire', 'Bypass'],
  timeout:       ['Substitute', 'Bypass']
}

function helperBag() {
  return {
    bindSkill, parsePred, predArg,
    downstreamReq(dag, node) {
      const req = new Set()
      dag.edges.forEach(e => {
        if (e.from === node.id) {
          const t = dag.nodes.find(n => n.id === e.to)
          if (t && t.precondition) t.precondition.forEach(p => req.add(p))
        }
      })
      const snk = dag.nodes.find(n => n.id === 'snk')
      if (snk) snk.precondition.forEach(p => { if (node.effect.indexOf(p) >= 0) req.add(p) })
      return Array.from(req).filter(p => node.effect.indexOf(p) >= 0)
    },
    deriveArgs(cand, concrete) {
      const args = (cand.params || []).map(() => null)
      const cp = parsePred(concrete)
      if (!cp) return args
      ;(cand.effect || []).forEach(g => {
        const gp = parsePred(g)
        if (gp && gp.name === cp.name && gp.args.length === cp.args.length) {
          gp.args.forEach((ga, i) => {
            const pi = cand.params.indexOf(ga)
            if (pi >= 0) args[pi] = cp.args[i]
          })
        }
      })
      return args
    }
  }
}

async function repairWith(deps, dag, event) {
  const { params, skillSource, operators, store } = deps
  const node = dag.nodes.find(n => n.id === event.nodeId)
  if (!node) return { ok: false, error: 'node not found: ' + event.nodeId }
  if (node.repairBudget <= 0) return { ok: true, repaired: false, escalate: 'local-exhausted', dag }

  node.repairBudget--
  node.repairCount++
  const library = await skillSource.list()
  const order = params.operatorOrder || DEFAULT_ORDER[event.type] || DEFAULT_ORDER.precondition
  const helpers = helperBag()

  for (const name of order) {
    const op = operators[name]
    if (!op) continue
    const patch = await op({ dag, node, event, library, params, helpers })
    if (patch) {
      node.status = 'ready'
      layoutNodes(dag.nodes, dag.edges)
      await store.set('plan:' + dag.planId, dag)
      return { ok: true, repaired: true, dag, patch }
    }
  }
  return { ok: true, repaired: false, escalate: 'local-failed', dag }
}
```

### 3.6 工厂函数：Core 的唯一出口

```js
function createGraspCore(options) {
  const opts = options || {}
  const params = Object.assign({}, DEFAULT_PARAMS, opts.params || {})
  const deps = {
    params,
    skillSource: opts.skillSource,               // 必填
    proposer: opts.proposer || { propose: async ({ retrieval, skills }) => {
      const byId = {}; skills.forEach(s => { byId[s.id] = s })
      return (retrieval ? retrieval.skills : []).map(id => ({ skill: id, args: byId[id].args || [] }))
    } },
    store: opts.store || memoryStore(),
    llmClient: opts.llmClient || null,
    // 允许第三方注册/覆盖算子
    operators: Object.assign({}, BUILTIN_OPERATORS, opts.operators || {})
  }
  if (!deps.skillSource) throw new Error('createGraspCore: skillSource is required')

  return {
    params,
    async compile(input) { return compileWith(deps, input || {}) },
    async verify(planId, nodeId, before, after) {
      const dag = await deps.store.get('plan:' + planId)
      if (!dag) return { ok: false, error: 'plan not found: ' + planId }
      const res = await verifyNode(deps, dag, nodeId, before, after)
      await deps.store.set('plan:' + planId, dag)
      return res
    },
    async repair(planId, event) {
      const dag = await deps.store.get('plan:' + planId)
      if (!dag) return { ok: false, error: 'plan not found: ' + planId }
      return repairWith(deps, dag, event)
    },
    async retrieveOnly(task) {
      const skills = await deps.skillSource.list()
      const episodes = (await deps.store.get('memory:episodes')) || []
      return retrieve({ skills, goal: [], task, episodes, params })
    },
    route(confidence) { return route(confidence, params) },
    async record({ task, trajectory, success }) {
      const episodes = (await deps.store.get('memory:episodes')) || []
      episodes.push({ task: task || '', trajectory: Array.isArray(trajectory) ? trajectory : [], success: success ? 1 : 0 })
      await deps.store.set('memory:episodes', episodes)
      return { recorded: true, memorySize: episodes.length }
    },
    async getPlan(planId) { return deps.store.get('plan:' + planId) },
    // 运行时改参数，不用重建实例
    setParams(patch) { Object.assign(params, patch || {}); return params }
  }
}

function memoryStore() {
  const m = new Map()
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { m.set(k, v) },
    del: async (k) => { m.delete(k) },
    keys: async (prefix) => Array.from(m.keys()).filter(k => !prefix || k.startsWith(prefix))
  }
}

module.exports = { createGraspCore, memoryStore, DEFAULT_PARAMS, BUILTIN_OPERATORS, DEFAULT_ORDER }
```

---

## 4. Adapter 层：三个 SkillSource 与 Host 半

换 harness 只需重写本节。Core 完全不动。

### 4.1 SkillSource 三实现

```js
// ① manifest —— 手写 JSON，保留用于单测与 demo
function manifestSource(manifest) {
  const skills = (manifest && manifest.skills) || []
  return {
    list: async () => skills,
    get: async (id) => skills.find(s => s.id === id) || null,
    meta: { goal: (manifest && manifest.goal) || [], initial: (manifest && manifest.initial_conditions) || [] }
  }
}

// ② dshSkills —— 读 DSH 真实技能库（本次改造的 P0）
function dshSkillsSource(ctx, opts) {
  const o = opts || {}
  const cache = { at: 0, val: null }
  const TTL = o.ttlMs || 5000

  async function load() {
    if (cache.val && Date.now() - cache.at < TTL) return cache.val
    const skillsApi = ctx.skills
    if (!skillsApi) return []
    const listed = await skillsApi.list()
    const out = []
    const skipped = []
    for (const item of listed) {
      const full = (await skillsApi.get(item.name)) || item
      const g = extractGraspMeta(full)
      if (!g) { skipped.push({ name: item.name, reason: 'no grasp: block in frontmatter' }); continue }
      out.push({
        id: slug(item.name),
        name: full.title || item.name,
        description: full.description || '',
        params: g.params || [],
        precondition: g.precondition || [],
        effect: g.effect || [],
        args: g.args || [],
        softVerify: g.softVerify !== false
      })
    }
    cache.val = out
    cache.at = Date.now()
    cache.skipped = skipped
    return out
  }

  return {
    list: load,
    get: async (id) => (await load()).find(s => s.id === id) || null,
    // 让上层能告知用户"哪些技能没进图、为什么"
    skipped: () => cache.skipped || []
  }
}

// ③ frontmatter —— 从 SKILL.md 文本抽取（不依赖具体 harness 的 skills API）
function frontmatterSource(files) {
  // files: [{ name, content }]
  const parsed = []
  const skipped = []
  files.forEach(f => {
    const g = extractGraspMeta(parseFrontmatter(f.content))
    if (!g) { skipped.push({ name: f.name, reason: 'no grasp: block' }); return }
    parsed.push({
      id: slug(f.name), name: g.name || f.name,
      description: g.description || '',
      params: g.params || [], precondition: g.precondition || [],
      effect: g.effect || [], args: g.args || []
    })
  })
  return {
    list: async () => parsed,
    get: async (id) => parsed.find(s => s.id === id) || null,
    skipped: () => skipped
  }
}

// ---- 共用小工具 ----
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
}

// 极简 YAML 子集解析：只处理 grasp 段需要的 key: value 与 [a, b] 数组
function parseFrontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(String(text || ''))
  if (!m) return null
  const body = m[1]
  const root = {}
  let cur = root
  const lines = body.split('\n')
  lines.forEach(line => {
    if (!line.trim() || /^\s*#/.test(line)) return
    const indented = /^\s{2,}\S/.test(line)
    const kv = /^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) return
    const key = kv[1]
    const raw = kv[2].trim()
    const target = indented ? cur : root
    if (raw === '') {
      // 开一个子对象（如 grasp:）
      root[key] = root[key] || {}
      cur = root[key]
      return
    }
    target[key] = parseScalar(raw)
  })
  return root
}
function parseScalar(raw) {
  if (/^\[.*\]$/.test(raw)) return parseInlineArray(raw.slice(1, -1))
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw.replace(/^["']|["']$/g, '')
}

// 关键：谓词里含逗号（如 at(agent,sink)），不能按逗号裸切。
// 只在引号外、且括号深度为 0 时才断项。
function parseInlineArray(inner) {
  const s = String(inner).trim()
  if (!s) return []
  const out = []
  let buf = '', depth = 0, quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = null
      else buf += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '(' || ch === '[') { depth++; buf += ch; continue }
    if (ch === ')' || ch === ']') { depth--; buf += ch; continue }
    if (ch === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(x => x.length > 0)
}
function extractGraspMeta(obj) {
  if (!obj) return null
  const g = obj.grasp || obj.GraSP || null
  if (!g) return null
  // precondition / effect 至少要有一个非空，否则这个技能对编译无意义
  const pre = g.precondition || [], eff = g.effect || []
  if (!pre.length && !eff.length) return null
  return {
    name: obj.name, description: obj.description,
    params: g.params || [], precondition: pre, effect: eff,
    args: g.args || [], softVerify: g.softVerify
  }
}
```

### 4.2 Proposer 三实现

```js
function createProposer(kind, opts) {
  const o = opts || {}
  if (kind === 'explicit') {
    return { propose: async () => (o.list || []) }
  }
  if (kind === 'retrieval') {
    return { propose: async ({ retrieval, skills }) => {
      const byId = {}; skills.forEach(s => { byId[s.id] = s })
      return (retrieval ? retrieval.skills : []).map(id => ({ skill: id, args: byId[id].args || [] }))
    } }
  }
  if (kind === 'llm') {
    const fallback = createProposer(o.fallback || 'retrieval', o)
    return { propose: async (input) => {
      if (!o.llmClient) return fallback.propose(input)
      const { task, skills } = input
      const catalog = skills.map(s =>
        '- ' + s.id + '(' + (s.params || []).join(', ') + ')'
        + '  pre=[' + (s.precondition || []).join('; ') + ']'
        + '  eff=[' + (s.effect || []).join('; ') + ']').join('\n')
      const prompt = [
        'Task: ' + task,
        '', 'Available skills:', catalog,
        '', 'Propose the minimal ordered set of skill invocations to accomplish the task.',
        'Bind every parameter to a concrete value.',
        'Reply with ONLY a JSON array, no prose: [{"skill":"<id>","args":["<v>"]}]'
      ].join('\n')
      try {
        const raw = await o.llmClient.complete({ prompt, temperature: 0 })
        const json = /\[[\s\S]*\]/.exec(String(raw || ''))
        if (!json) return fallback.propose(input)
        const arr = JSON.parse(json[0])
        if (!Array.isArray(arr) || !arr.length) return fallback.propose(input)
        return arr
      } catch (e) {
        return fallback.propose(input)   // 解析失败降级，不中断
      }
    } }
  }
  throw new Error('unknown proposer kind: ' + kind)
}
```

### 4.3 Storage：接 harness 持久化

```js
function kvStore(storage, prefix) {
  const p = prefix || 'grasp:'
  return {
    get: async (k) => {
      const raw = await storage.get(p + k)
      if (raw === undefined || raw === null) return null
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    },
    set: async (k, v) => { await storage.set(p + k, JSON.stringify(v)) },
    del: async (k) => { await storage.delete ? storage.delete(p + k) : storage.set(p + k, null) },
    keys: async (pre) => {
      const all = (await storage.keys ? storage.keys() : []) || []
      return all.filter(k => k.startsWith(p + (pre || ''))).map(k => k.slice(p.length))
    }
  }
}
```

### 4.4 Host 半（`code.host` 的值）

这一层现在很薄——只做装配与工具注册，逻辑全在 Core。

```js
return {
  apply(ctx) {
    // ---- 在此粘贴 §3 全部 Core 代码，去掉最后的 module.exports ----
    // ---- 在此粘贴 §4.1–4.3 全部 Adapter 代码 ----

    // ===== 装配：按环境能力自动降级 =====
    const cfg = (ctx.get && ctx.get('config')) || {}
    const graspCfg = cfg.grasp || {}

    // LLM：有就用，没有就 null（Core 会自动降级到 retrieval proposer + strict verify）
    let llmClient = null
    const llm = ctx.get && ctx.get('llm')
    if (llm) {
      llmClient = {
        complete: async ({ prompt, temperature }) => {
          const res = await llm.stream({
            messages: [{ role: 'user', content: prompt }],
            temperature: typeof temperature === 'number' ? temperature : 0
          })
          return (res && (res.text || res.content)) || ''
        }
      }
    }

    // Storage：有 ctx.storage 就持久化，否则进程内
    const store = ctx.storage ? kvStore(ctx.storage) : memoryStore()

    // SkillSource：优先真实技能库；技能库为空时回落 demo manifest
    const realSource = dshSkillsSource(ctx)
    const demoSource = manifestSource(APPLE.manifest)
    const skillSource = {
      list: async () => {
        const real = await realSource.list()
        if (real.length) return real
        return demoSource.list()
      },
      get: async (id) => (await skillSource.list()).find(s => s.id === id) || null,
      skipped: () => realSource.skipped(),
      usingDemo: async () => (await realSource.list()).length === 0
    }

    const core = createGraspCore({
      params: graspCfg.params || {},
      skillSource,
      proposer: createProposer(graspCfg.proposer || (llmClient ? 'llm' : 'retrieval'), { llmClient }),
      store,
      llmClient,
      operators: graspCfg.operators || {}
    })

    // ===== RPC（供 Client 调用）=====
    harness.handle('grasp.compile',  async (a) => core.compile(a || {}))
    harness.handle('grasp.verify',   async (a) => core.verify(a.planId, a.nodeId, a.before, a.after))
    harness.handle('grasp.repair',   async (a) => core.repair(a.planId, a.event))
    harness.handle('grasp.retrieve', async (a) => core.retrieveOnly(a.task || ''))
    harness.handle('grasp.record',   async (a) => core.record(a || {}))
    harness.handle('grasp.route',    async (a) => core.route(a.confidence))
    harness.handle('grasp.getPlan',  async (a) => core.getPlan(a.planId))
    harness.handle('grasp.params',   async (a) => (a && a.patch ? core.setParams(a.patch) : core.params))
    harness.handle('grasp.demo',     async () => APPLE)
    harness.handle('grasp.status',   async () => ({
      usingDemo: await skillSource.usingDemo(),
      skipped: skillSource.skipped(),
      hasLLM: !!llmClient,
      persistent: !!ctx.storage,
      params: core.params
    }))

    // ===== 模型工具 =====
    const OUT = { type: 'object', additionalProperties: true }
    const renderJson = (args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    const def = (name, description, parameters, execute) =>
      harness.registerTool(ctx, harness.defineTool({
        name, description, parameters, output: { schema: OUT, render: renderJson }, execute
      }))

    def('grasp_compile',
      'Compile the available skills into a typed executable DAG (GraSP-style). Reads the real skill library when available. Runs memory-conditioned retrieval first: if confidence is low it returns a react-fallback with no DAG.',
      {
        task: { type: 'string', required: true, description: 'Task description (drives retrieval + routing).' },
        goal: { type: 'json', description: 'Goal predicates, e.g. ["clean(apple)"].' },
        initialConditions: { type: 'json', description: 'Predicates true at start.' },
        proposal: { type: 'json', description: 'Optional explicit node proposals [{skill, args}]; omit to let the proposer decide.' }
      },
      async (a) => core.compile(a))

    def('grasp_verify',
      'Verify one executed DAG node: precondition against state-before, effect against state-after. Returns pass/fail plus a typed failure event.',
      {
        planId: { type: 'string', required: true },
        nodeId: { type: 'string', required: true },
        before: { type: 'json', description: 'True predicates before execution.' },
        after: { type: 'json', description: 'True predicates after execution.' }
      },
      async (a) => core.verify(a.planId, a.nodeId, a.before, a.after))

    def('grasp_repair',
      'Apply a bounded local repair (typed operators) to a failed DAG node. Returns the repaired DAG plus the patch.',
      {
        planId: { type: 'string', required: true },
        event: { type: 'json', required: true, description: 'Failure event {nodeId, type, message, state}.' }
      },
      async (a) => core.repair(a.planId, a.event))

    def('grasp_retrieve',
      'Memory-conditioned skill retrieval (GraSP Eq.1/2): fuses direct semantic similarity with episodic memory, returns top-M skills, features and calibrated confidence.',
      { task: { type: 'string', required: true } },
      async (a) => core.retrieveOnly(a.task || ''))

    def('grasp_record',
      'Record an episode (task, skill trajectory, success) into the experience memory used by retrieval. Persisted when storage is available.',
      {
        task: { type: 'string', required: true },
        trajectory: { type: 'json', description: 'Ordered skill ids used.' },
        success: { type: 'boolean' }
      },
      async (a) => core.record(a))

    def('grasp_status',
      'Report GraSP plugin wiring: whether the real skill library is in use, which skills were skipped and why, whether LLM and persistence are available, and current parameters.',
      {},
      async () => ({
        usingDemo: await skillSource.usingDemo(),
        skipped: skillSource.skipped(),
        hasLLM: !!llmClient,
        persistent: !!ctx.storage,
        params: core.params
      }))

    console.log('[grasp] core + adapters + tools registered')
  }
}
```

`APPLE` demo 常量（保留，仅作技能库为空时的兜底）：

```js
const APPLE = {
  task: 'clean an apple and put it on the countertop',
  manifest: {
    goal: ['clean(apple)', 'on(apple,countertop)'],
    initial_conditions: ['at(agent,fridge)'],
    skills: [
      { id: 'find',  name: 'Find object',      params: ['object'],        precondition: [], effect: ['knows_loc(object)'] },
      { id: 'open',  name: 'Open receptacle',  params: [],                precondition: [], effect: ['open(fridge)'] },
      { id: 'pick',  name: 'Pick object',      params: ['object'],        precondition: ['knows_loc(object)', 'open(fridge)'], effect: ['holding(object)'] },
      { id: 'goto',  name: 'Go to location',   params: ['loc'],           precondition: [], effect: ['at(agent,loc)'] },
      { id: 'clean', name: 'Clean object',     params: ['object'],        precondition: ['holding(object)', 'at(agent,sink)'], effect: ['clean(object)'] },
      { id: 'put',   name: 'Put object',       params: ['object','loc'],  precondition: ['holding(object)', 'at(agent,loc)'],  effect: ['on(object,loc)'] },
      { id: 'heat',  name: 'Heat object',      params: ['object'],        precondition: ['holding(object)'], effect: ['hot(object)'] },
      { id: 'slice', name: 'Slice object',     params: ['object'],        precondition: ['holding(object)'], effect: ['sliced(object)'] }
    ]
  },
  proposal: [
    { skill: 'find',  args: ['apple'] },
    { skill: 'open',  args: [] },
    { skill: 'pick',  args: ['apple'] },
    { skill: 'clean', args: ['apple'] },
    { skill: 'put',   args: ['apple', 'countertop'] },
    { skill: 'heat',  args: ['apple'] },
    { skill: 'slice', args: ['apple'] }
  ]
}
```

---

## 5. Client 半（`code.client` 的值）

相比初版增加：状态条显示「是否在用真实技能库 / 被跳过的技能 / 有无 LLM / 是否持久化」，以及一个参数微调面板（改 τ / L_max 后可立即重编译观察差异）。

```js
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert('.grasp-card{padding:6px}.grasp-btn{background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}.grasp-btn:disabled{opacity:.5;cursor:default}.grasp-btn.alt{background:#0e7490}.grasp-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(2,6,23,.66);display:flex;align-items:center;justify-content:center;pointer-events:auto;z-index:9999}.grasp-modal{width:94vw;height:90vh;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 24px 70px rgba(0,0,0,.7);color:#e2e8f0;font:12px/1.4 system-ui,sans-serif}.grasp-head{display:flex;align-items:center;justify-content:space-between}.grasp-head h3{margin:0;font-size:15px}.grasp-close{background:#334155;color:#e2e8f0;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}.grasp-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.grasp-meta{color:#94a3b8;font-size:11px}.grasp-warn{color:#fbbf24;font-size:11px}.grasp-legend{display:flex;gap:10px;font-size:11px;color:#94a3b8;flex-wrap:wrap}.grasp-scroll{overflow:auto;flex:1;min-height:0;border-radius:8px}.grasp-num{width:52px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:2px 4px;font-size:11px}')

    const STATUS_COLOR = { verified: '#16a34a', failed: '#dc2626', ready: '#eab308', executing: '#2563eb', pending: '#64748b', bypassed: '#86efac' }
    const EDGE_STYLE = {
      state: { stroke: '#3b82f6', dash: '', w: 1.7 },
      data:  { stroke: '#a855f7', dash: '5,4', w: 1.2 },
      order: { stroke: '#94a3b8', dash: '2,4', w: 1.1 }
    }

    let overlayOpen = false
    const listeners = new Set()
    function setOpen(v) { overlayOpen = v; listeners.forEach(f => f(v)) }
    function useOpen() {
      const st = React.useState(overlayOpen)
      React.useEffect(function () {
        function f(v) { st[1](v) }
        listeners.add(f)
        return function () { listeners.delete(f) }
      }, [])
      return st[0]
    }

    function arrow(id, color) {
      return React.createElement('marker',
        { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' },
        React.createElement('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }))
    }

    function DAGView(dag) {
      if (!dag) return React.createElement('div', { className: 'grasp-meta' }, 'No DAG (routed to ReAct fallback, or not compiled yet).')
      const nodes = dag.nodes || [], edges = dag.edges || []
      const byId = {}
      nodes.forEach(n => { byId[n.id] = n })
      const nodeW = 160, nodeH = 54
      let maxX = 260, maxY = 130
      nodes.forEach(n => {
        maxX = Math.max(maxX, (n.x || 0) + nodeW + 20)
        maxY = Math.max(maxY, (n.y || 0) + nodeH + 20)
      })

      const groups = {}
      edges.forEach(e => { const k = e.from + '|' + e.to; (groups[k] = groups[k] || []).push(e) })

      const edgeEls = []
      edges.forEach(function (e, i) {
        const a = byId[e.from], b = byId[e.to]
        if (!a || !b) return
        const grp = groups[e.from + '|' + e.to]
        const off = (grp.indexOf(e) - (grp.length - 1) / 2) * 26
        const x1 = (a.x || 0) + nodeW, y1 = (a.y || 0) + nodeH / 2
        const x2 = b.x || 0,           y2 = (b.y || 0) + nodeH / 2
        const dx = x2 - x1, dy = y2 - y1
        const len = Math.hypot(dx, dy) || 1
        const nx = -dy / len, ny = dx / len
        const cx = (x1 + x2) / 2 + nx * off, cy = (y1 + y2) / 2 + ny * off
        const d = 'M' + x1 + ',' + y1 + ' Q' + cx + ',' + cy + ' ' + x2 + ',' + y2
        const st = EDGE_STYLE[e.type] || EDGE_STYLE.order
        const path = React.createElement('path', { key: 'p' + i, d, fill: 'none', stroke: st.stroke, strokeWidth: st.w, strokeDasharray: st.dash, markerEnd: 'url(#ah-' + e.type + ')' })
        let label = e.label
        if (e.type === 'data') label = String(e.label).split(' → ')[0]
        const lx = cx + nx * 9, ly = cy + ny * 9
        const tw = String(label).length * 5.4 + 10
        const bg = React.createElement('rect', { x: lx - tw / 2, y: ly - 7.5, width: tw, height: 14, rx: 3, fill: '#020617', opacity: 0.92 })
        const txt = React.createElement('text', { x: lx, y: ly + 3.5, fill: st.stroke, fontSize: 8.5, textAnchor: 'middle' }, label)
        edgeEls.push(React.createElement('g', { key: 'e' + i }, path, bg, txt))
      })

      const nodeEls = nodes.map(function (n) {
        const isTerm = n.kind === 'src' || n.kind === 'snk'
        const fill = isTerm ? '#334155' : (STATUS_COLOR[n.status] || STATUS_COLOR.pending)
        const x = n.x || 0, y = n.y || 0
        return React.createElement('g', { key: n.id },
          React.createElement('title', null, n.id + ' | pre: ' + ((n.precondition || []).join(', ') || 'none')),
          React.createElement('rect', { x, y, width: nodeW, height: nodeH, rx: 8, fill: '#0f172a', stroke: fill, strokeWidth: 2 }),
          React.createElement('text', { x: x + 9, y: y + 17, fill: '#f1f5f9', fontSize: 12, fontWeight: 600 }, n.name || n.id),
          React.createElement('text', { x: x + 9, y: y + 32, fill: '#94a3b8', fontSize: 10 }, 'args: ' + ((n.args || []).join(', ') || '—')),
          React.createElement('text', { x: x + 9, y: y + 46, fill: '#7dd3fc', fontSize: 10 }, 'eff: ' + ((n.effect || []).join(', ') || '—')))
      })

      const defs = React.createElement('defs', null,
        arrow('ah-state', '#3b82f6'), arrow('ah-data', '#a855f7'), arrow('ah-order', '#94a3b8'))

      return React.createElement('svg',
        { viewBox: '0 0 ' + maxX + ' ' + maxY, style: { background: '#020617', borderRadius: 8, display: 'block', width: '100%', height: 'auto' } },
        defs, React.createElement('g', null, edgeEls, nodeEls))
    }

    function Overlay() {
      const open = useOpen()
      const [dag, setDag] = React.useState(null)
      const [planId, setPlanId] = React.useState(null)
      const [meta, setMeta] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [tauHigh, setTauHigh] = React.useState(0.65)
      const [lMax, setLMax] = React.useState(3)

      async function refreshStatus() {
        try { setStatus(await host.call('grasp.status', {})) } catch (e) { /* 状态失败不阻断主流程 */ }
      }

      async function compile() {
        setBusy(true); setErr('')
        try {
          const demo = await host.call('grasp.demo', {})
          const res = await host.call('grasp.compile', {
            task: demo.task,
            goal: demo.manifest.goal,
            initialConditions: demo.manifest.initial_conditions,
            proposal: demo.proposal
          })
          if (!res.ok) { setErr(res.reason || 'compile failed'); return }
          if (!res.dag) {
            setDag(null); setPlanId(null)
            setMeta('routing: ' + (res.routing && res.routing.mode) + ' — no DAG compiled')
            return
          }
          setDag(res.dag); setPlanId(res.dag.planId)
          const c = res.dag.routing && typeof res.dag.routing.confidence === 'number'
            ? res.dag.routing.confidence.toFixed(2) : '—'
          const rej = (res.dag.rejected || []).length
          setMeta(res.dag.filtered + ' | c_ret=' + c + ' (' + res.dag.routing.mode + ')'
            + (rej ? ' | ' + rej + ' proposal(s) rejected' : ''))
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
        finally { setBusy(false) }
      }

      async function applyParams() {
        setBusy(true)
        try {
          await host.call('grasp.params', { patch: { tauHigh: Number(tauHigh), lMax: Number(lMax) } })
          await compile()
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
        finally { setBusy(false) }
      }

      async function injectFailure() {
        if (!planId) return
        setBusy(true); setErr('')
        try {
          const before = ['at(agent,fridge)', 'knows_loc(apple)', 'open(fridge)', 'holding(apple)']
          const after = ['clean(apple)']
          const v = await host.call('grasp.verify', { planId, nodeId: 'clean:1', before, after })
          if (!v.ok) { setErr(v.error); return }
          if (v.pass) { setMeta('clean:1 passed (no failure injected)'); return }
          const r = await host.call('grasp.repair', { planId, event: v.event })
          if (r.ok && r.repaired) {
            setDag(r.dag)
            setMeta('repair: ' + r.patch.operator + ' +' + ([].concat(r.patch.patch.addedNodes || [])).join(','))
          } else setMeta('repair: ' + (r.escalate || 'not repaired'))
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
        finally { setBusy(false) }
      }

      async function recordSuccess() {
        setBusy(true); setErr('')
        try {
          const demo = await host.call('grasp.demo', {})
          const rec = await host.call('grasp.record', {
            task: demo.task, trajectory: ['find','open','pick','goto','clean','put'], success: true
          })
          setMeta('recorded episode (memory size ' + rec.memorySize + ') → recompiling…')
          await compile()
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
        finally { setBusy(false) }
      }

      React.useEffect(function () {
        if (open) { refreshStatus(); if (dag === null && !err) compile() }
      }, [open])

      if (!open) return null

      const wiring = status ? React.createElement('div', { className: status.usingDemo ? 'grasp-warn' : 'grasp-meta' },
        (status.usingDemo
          ? '⚠ using built-in apple demo — no skill in your library declares a grasp: frontmatter block'
          : '✓ using real skill library')
        + ' | LLM: ' + (status.hasLLM ? 'on' : 'off (retrieval proposer)')
        + ' | storage: ' + (status.persistent ? 'persistent' : 'in-memory')
        + ((status.skipped && status.skipped.length) ? ' | skipped ' + status.skipped.length + ' skill(s)' : '')) : null

      const tuner = React.createElement('div', { className: 'grasp-row' },
        React.createElement('span', { className: 'grasp-meta' }, 'τ_high'),
        React.createElement('input', { className: 'grasp-num', type: 'number', step: '0.05', value: tauHigh, onChange: e => setTauHigh(e.target.value) }),
        React.createElement('span', { className: 'grasp-meta' }, 'L_max'),
        React.createElement('input', { className: 'grasp-num', type: 'number', step: '1', value: lMax, onChange: e => setLMax(e.target.value) }),
        React.createElement('button', { className: 'grasp-btn alt', onClick: applyParams, disabled: busy }, 'Apply & recompile'))

      const legend = React.createElement('div', { className: 'grasp-legend' },
        'edges: ',
        React.createElement('span', { style: { color: '#3b82f6' } }, 'state ──  '),
        React.createElement('span', { style: { color: '#a855f7' } }, 'data ╌╌  '),
        React.createElement('span', { style: { color: '#94a3b8' } }, 'order ··'),
        '   status: ',
        React.createElement('span', { style: { color: '#16a34a' } }, 'verified '),
        React.createElement('span', { style: { color: '#64748b' } }, 'pending '),
        React.createElement('span', { style: { color: '#dc2626' } }, 'failed'))

      return React.createElement('div', { className: 'grasp-backdrop' },
        React.createElement('div', { className: 'grasp-modal' },
          React.createElement('div', { className: 'grasp-head' },
            React.createElement('h3', null, 'GraSP skill DAG'),
            React.createElement('button', { className: 'grasp-close', onClick: () => setOpen(false) }, 'Close')),
          wiring, legend,
          React.createElement('div', { className: 'grasp-row' },
            React.createElement('button', { className: 'grasp-btn', onClick: compile, disabled: busy }, 'Recompile'),
            React.createElement('button', { className: 'grasp-btn', onClick: injectFailure, disabled: busy || !planId }, 'Inject failure → repair'),
            React.createElement('button', { className: 'grasp-btn alt', onClick: recordSuccess, disabled: busy }, 'Record success → recompile')),
          tuner,
          React.createElement('div', { className: 'grasp-meta' }, meta),
          err ? React.createElement('div', { className: 'grasp-meta', style: { color: '#f87171' } }, err) : null,
          React.createElement('div', { className: 'grasp-scroll' }, DAGView(dag))))
    }

    function Card() {
      return React.createElement('div', { className: 'grasp-card' },
        React.createElement('button', { className: 'grasp-btn', onClick: () => setOpen(true) }, 'Open GraSP DAG viewer'))
    }

    slots.inject('tool.view.cordis', function () {
      return slots.register({ name: 'tool.view.cordis', key: 'self' }, function () { return React.createElement(Card) })
    })
    slots.inject('shell.overlay', function () {
      return slots.register({ name: 'shell.overlay', id: 'grasp-dag-viewer' }, function () { return React.createElement(Overlay) })
    })
  }
}
```

---

## 6. 复刻步骤

1. 取 §3（Core，去掉末尾 `module.exports`）+ §4.1–4.3（Adapter）+ §4.4 的装配与注册部分，拼成 `code.host` 的值；取 §5 全文作 `code.client` 的值。两者都以 `return {` 开头、以 `}` 结尾，**去掉 ```js 围栏**。
2. 调用 `cordis_define`：
   - `plugin`: `{ "kind": "new", "idPrefix": "grasp" }`
   - `name`: `GraSP Skill DAG Compiler`
   - `purpose`: `Compile a skill library into a typed executable DAG (GraSP-style) with verification, bounded local repair, memory-conditioned retrieval and confidence routing. Pluggable skill source, proposer and storage.`
   - `code`: `{ "host": "<§3+§4>", "client": "<§5>" }`
   - 记录返回的 `pluginId`（形如 `grasp-1`）与 `packageId`（形如 `pkg-1`）。
3. 调用 `cordis_run`：`{ "pluginId": <返回值>, "packageId": <返回值>, "mode": "run" }`
   - 返回 `awaiting-approval` → 让用户在 UI 点「允许」。
   - 返回 `starting` → 进入异步流程，等系统通过 steering 报告最终结果；**`starting` 不等于成功**。
4. 成功标志：`currentPackageId` 指向该 package；run 卡片出现「Open GraSP DAG viewer」按钮。
5. 打开浮层，先看状态条：
   - 显示 `✓ using real skill library` → 真实技能库已接上。
   - 显示 `⚠ using built-in apple demo` → 你的技能都没写 `grasp:` frontmatter 段，此时跑的是 demo。这是**预期行为**，不是 bug。
6. 自检三项：
   - 「Recompile」→ 出现 DAG。
   - 「Inject failure → repair」→ `clean` 节点变红后插入 `goto:1`，meta 显示 `repair: InsertPrereq +goto:1`。
   - 「Record success → recompile」→ c_ret 明显上升。
7. 灵活性自检（本版新增，务必做）：
   - 把 `τ_high` 调到 `0.99` → Apply，模式应从 `full-dag` 落到 `full-dag-boosted-repair`。
   - 把 `L_max` 调到 `0` → Apply → Inject failure，`InsertPrereq` 应失效并回退到后续算子或 `local-failed`。
   - 这两项能改变行为，才证明参数真的接进去了，而不是摆设。

---

## 7. 验证预期

**编译**（apple demo，8 技能）：过滤后 `5 of 8 skills kept`（heat/slice 被剪）；plan = `find → open → pick → clean → put`；state 边 find→pick、open→pick、pick→clean、pick→put；data 边 find→pick、pick→clean、pick→put（全正向无环）。

**修复**：`clean:1` 前置失败 → `InsertPrereq` 插入 `goto:1`，ΔV=1、ΔE=2、祖先不动。

**检索置信度**：空记忆 + apple 任务 ≈0.48（boosted-repair）；记录成功 episode 后 ≈0.90（full-dag）；无关任务 ≈0.32（react-fallback，不编图）。

**本版新增的可测项**：

| 测项 | 期望 |
|---|---|
| Core 零依赖 | `grep -E 'harness|ctx\.|React' src/core/index.js` 无输出 |
| Core 可单测 | `createGraspCore({ skillSource: manifestSource(APPLE.manifest) })` 在纯 node 下可 compile 出上述 plan |
| 参数可覆盖 | `setParams({ tauHigh: 0.99 })` 后同一任务的 routing.mode 改变 |
| 有界性 | `setParams({ lMax: 0 })` 后 `InsertPrereq` 返回 null，不再插节点 |
| 算子可注册 | 传入 `operators: { MyOp: ctx => ({operator:'MyOp',patch:{},bounded:true}) }` 且 `operatorOrder: ['MyOp']`，修复结果的 operator 为 `MyOp` |
| 幻觉防线 | proposal 里塞一个不存在的 skill 或错误 arity，编译结果的 `rejected` 应记录它且不入图 |
| 持久化 | 用 `kvStore` 时重启后 `getPlan(planId)` 仍能取回 |
| frontmatter 抽取 | 一个含 `grasp:` 段的 SKILL.md 能被 `frontmatterSource` 解析出 params/precondition/effect |
| 跳过可见 | 不含 `grasp:` 段的技能出现在 `grasp_status` 的 `skipped` 里，附 reason |

### 7.1 本文档代码的实测记录

§3–§4 的代码**已在 node 下实跑通过**，非纸面推演。回归脚本见 `grasp-tests/`，一键运行 `bash grasp-tests/run_all.sh`（`extract_core.py` 会从本文档抽取代码，并断言 Core 仍零依赖）。

实测输出与上述期望逐项吻合：

| 测项 | 实测结果 |
|---|---|
| 编译过滤 | `5 of 8 skills kept` ✓ |
| plan | `find:1 → open:1 → pick:1 → clean:1 → put:1` ✓ |
| state 边 | find→pick、open→pick、pick→clean、pick→put ✓ |
| data 边 | find→pick、pick→clean、pick→put（全正向无环）✓ |
| c_ret 三档 | 空记忆 **0.4831**（boosted-repair）→ 记录 episode 后 **0.9009**（full-dag）→ 无关任务 **0.3248**（react-fallback，不编图）✓ |
| 修复 | `InsertPrereq` 插入 `goto:1`，ΔV=1、ΔE=2 ✓ |
| 有界性 | `lMax=0` → InsertPrereq 失效，升级为 `local-failed` ✓ |
| 幻觉防线 | `rejected: [{nonexistent, unknown skill}, {find, arity 2 != 1}]` ✓ |
| 算子可注册 | 自定义 `MyOp` 被调用并返回 patch ✓ |
| 持久化 | 换新 core 实例后 `getPlan` 恢复成功、记忆存活（c_ret 0.9232）、planId 不撞车（plan_1 → plan_2）✓ |
| frontmatter 抽取 | 2 个含 `grasp:` 段的技能解析成功，第 3 个进 `skipped` 并附 reason ✓ |
| LLM proposer 降级 | 输出垃圾 / 抛异常 / 无 LLM 三种情况均正确回退 retrieval，不中断 ✓ |
| soft verify | 效果未观测时 `pass=true mode=soft`；同输入 strict 判 `postcondition` 失败 ✓ |

**实测中抓到并已修掉的两个真 bug**（若你从初版自行改造，很可能踩到同样的坑）：

1. **YAML 数组按逗号裸切，撕碎多参数谓词。** 原 `parseScalar` 用 `inner.split(',')`，导致 `["holding(object)", "at(agent,sink)"]` 被解析成 `["holding(object)", "at(agent", "sink)"]` —— 任何含两个以上参数的谓词都会损坏，进而让 precondition 永远匹配不上。已改为 `parseInlineArray`：只在引号外且括号深度为 0 处断项。
2. **soft verify 被 bug 1 连带屏蔽。** 因为 strict 先报了 `precondition` 失败，而 soft 只在 `postcondition` 失败时才启用，导致软验证看起来"不生效"。修掉 bug 1 后自动恢复正常。

第 1 条尤其值得记住：它在 apple demo 里**不会暴露**（demo 走的是手写 manifest，不过 YAML 解析），只在接真实 SKILL.md 时才发作 —— 这正是「玩具 manifest 掩盖真实路径缺陷」的典型例子。

---

---

## 8. 关键 API 契约（避免重踩坑）

- **工具定义**：`harness.defineTool(def)` 必须声明 `output: { schema, render }`（值/呈现拆分契约），`render(args, value)` 返回内容块数组 `[{ type:'text', text: ... }]`；`parameters` 用 DSL 形式（如 `{ task: { type:'string', required:true } }`）。注册用 `harness.registerTool(ctx, tool)`。
- **槽位**：`tool.view.cordis`（keyed，`key: 'self'`，run 卡片内）+ `shell.overlay`（list，`id` 自定，全屏浮层；该层 click-through，根元素必须设 `pointer-events:auto`）。
- **Host↔Client RPC**：Host `harness.handle(method, handler)`，Client `host.call(method, args)`；只传无损 JSON。
- **LLM**：`ctx.get('llm')` → `llm.stream({ ...GenerateOptions, temperature: 0 })`；provider/model/凭据由 harness 配置解析，**不在源码里写死**。
- **技能库**：`ctx.skills` 提供 `list()` / `snapshot()` / `get(name)`。
- **持久化**：`ctx.storage` / `storageDomain` / `sessionPersistence`。
- **降级链（本版核心）**：无 `ctx.skills` 或无技能声明 `grasp:` → 回落 demo manifest；无 `ctx.llm` → proposer 落到 `retrieval`、verify 保持 `strict`；无 `ctx.storage` → 落 `memoryStore`。**每一级降级都必须在 `grasp_status` 里可见**，否则用户会把降级当成故障。

---

## 9. 剩余未实现（按优先级，已按上轮市场评估重排）

1. **抽出独立 npm 包** —— Core 已零依赖，把 §3 单独发包（如 `skill-dag`），README 标注「GraSP (arXiv:2604.17870) 的首个开源实现，unofficial」。这是受众从「用 DSH 的人」扩到「做 agent 编排的人」的唯一动作。
2. **LangGraph / MCP adapter** —— 复用同一 Core，各写约 80 行。证明「换 harness 只需换 adapter」不是口号。
3. 三层熔断的第 2/3 层：全局重规划（P_max=1）+ ReAct 兜底（弃图追 g_residual）。当前只有第 1 层局部修复。
4. 复现论文一个消融结论（建议选「局部修复 vs 全局重规划的恢复率差距」），贴出自己跑的数字 —— 这是复刻类项目唯一的可信度锚点。
5. 开发者编辑面板（`settings.section`）：让用户在 UI 里编 manifest 与看抽取结果。
6. 完整可视化交互（拖拽/缩放/平移/点边高亮）。
7. 平凡任务捷径显式分支（论文提到但本复刻未实现）。
8. 循环任务支持 —— 论文自己在 §6 承认 DAG 的无环假设「precludes cyclic execution patterns」，需要 loop 构造或 DAG unrolling。这是方法本身的边界，不是复刻的疏漏。

---

## 10. 已知偏差与诚实声明

对外发布时必须写清，否则会被指为夸大：

- **本项目为 unofficial reproduction。** 论文全文未给出任何 repo、license 或可复现声明，仅附录 F 提到 prompts 对应 `src/esg.py` 这一孤立路径。本复刻依据论文正文与附录重建，未见过官方代码。
- **超参数与论文 Appendix C.1 Table 3 对齐**（τ_low=0.40、τ_high=0.65、L_max=3、E_max=5、λ=0.5、η=0.7、k=M=5、h=2、R_max=2、P_max=1），但置信度的权重向量 `w` 与偏置 `b` 论文未给出具体数值，本实现取 `[1.2, 1.0, 0.8, 1.8]` 与 `-2.0` 为**自定经验值**，不是论文数字。这一条尤其要标注。
- 论文报告的 step 减少幅度（最多 41%）未计入编译器与验证器自身的 LLM 调用开销。若要对外报告性能，须自建口径并说明。
- `parseFrontmatter` 是极简 YAML 子集解析，只覆盖 `key: value` 与 `[a, b]` 两种形式，不支持多行数组、嵌套超过一层、锚点等。生产环境建议换成成熟 YAML 库。
- 论文的 Eq.1 检索用的是语义分布 `p_dir`，本实现用 token Jaccard 近似而非 embedding。要贴近论文应替换为真实 embedding 相似度（这也是一个天然的扩展点：把 `tokenSim` 做成可注入的 `similarity` 函数）。



