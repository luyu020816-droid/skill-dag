# skill-dag

**GraSP-style skill DAG compiler** — compile flat skill sets into typed executable DAGs with verified execution, bounded local repair, memory-conditioned retrieval and confidence routing.

[![npm version](https://img.shields.io/npm/v/skill-dag)](https://www.npmjs.com/package/skill-dag)
[![license](https://img.shields.io/npm/l/skill-dag)](LICENSE)
[![node](https://img.shields.io/node/v/skill-dag)](package.json)

> Unofficial reproduction of **[GraSP: Graph-Structured Skill Compositions for LLM Agents](https://arxiv.org/abs/2604.17870)** (Tencent, arXiv:2604.17870, 2026). The paper has **no official open-source implementation** — this is the first community reproduction. **Zero dependencies. Runs anywhere Node.js runs.**

---

## Why

Skill ecosystems for LLM agents have exploded, yet benchmarks show **more skills does not mean better performance** — 2–3 focused skills beat comprehensive documentation, and excessive skills actively hurt. The bottleneck has shifted from *skill availability* to **skill orchestration**.

Flat skill lists force the LLM to implicitly reason about *what to apply, in what order, under what conditions* — and a failure anywhere invalidates the whole suffix (O(N) replanning).

**skill-dag** adds the missing *compilation layer*: it transforms retrieved skills into a typed DAG with explicit causal edges, so the agent gets a verifiable execution plan and **local, bounded repair** (O(d^h), not O(N)).

## What it does

| Stage | What | Paper |
|---|---|---|
| **Memory-conditioned retrieval** | Fuses semantic skill matching with episodic experience (Eq.1), computes calibrated confidence (Eq.2) | §2.2 |
| **DAG compilation** | Typed edges — `state` (effect→precondition), `data` (output→input), `order` (soft precedence) — with cycle resolution, goal completeness, topological order | §2.3 |
| **Verified execution** | Pre/postcondition checking at every node (`strict` predicate sets, `soft` LLM fallback) | §2.4 |
| **Bounded local repair** | 5 typed operators — `Rebind`, `InsertPrereq`, `Substitute`, `Rewire`, `Bypass` — registry-based, reorderable, budget-bounded | §2.4 |
| **Confidence routing** | Below τ_low → ReAct fallback; above τ_high → full DAG; between → boosted repair | §2.5 |

## Install

```sh
npm install skill-dag
```

## Quick start

```js
const { createGraspCore, memoryStore, manifestSource, createProposer } = require('skill-dag')

const core = createGraspCore({
  params: { tauLow: 0.40, tauHigh: 0.65, lMax: 3, eMax: 5, lambda: 0.5, eta: 0.7, k: 5, m: 5, h: 2, rMax: 2, pMax: 1 },
  skillSource: manifestSource({
    goal: ['clean(apple)', 'on(apple,countertop)'],
    initial_conditions: ['at(agent,fridge)'],
    skills: [
      { id: 'find',  params: ['object'], effect: ['knows_loc(object)'] },
      { id: 'pick',  params: ['object'], precondition: ['knows_loc(object)', 'open(fridge)'], effect: ['holding(object)'] },
      { id: 'clean', params: ['object'], precondition: ['holding(object)', 'at(agent,sink)'], effect: ['clean(object)'] },
      { id: 'put',   params: ['object', 'loc'], precondition: ['holding(object)', 'at(agent,loc)'], effect: ['on(object,loc)'] },
    ],
  }),
  proposer: createProposer('retrieval'),
  store: memoryStore(),
})

const { ok, dag } = await core.compile({
  task: 'clean an apple and put it on the countertop',
  goal: ['clean(apple)', 'on(apple,countertop)'],
  initialConditions: ['at(agent,fridge)'],
})
// dag.plan === ['find:1', 'pick:1', 'clean:1', 'put:1']  (topological skill order)
// dag.edges — state/data/order typed edges with labels
```

### Local repair (the point)

```js
const v = await core.verify(dag.planId, 'clean:1', ['at(agent,fridge)', 'holding(apple)'], ['clean(apple)'])
// v.pass === false, v.event.type === 'precondition'  (missing at(agent,sink))

const r = await core.repair(dag.planId, v.event)
// r.patch.operator === 'InsertPrereq' — inserts a goto:1 node, ΔV=1 ΔE=2
// only the failed node's subgraph is touched; verified ancestors stay untouched
```

## Plug-in points

Everything is an interface with a zero-dependency default:

- **SkillSource** — where skills come from: `manifestSource(manifest)`, `dshSkillsSource(skillsApi, { llmClient, getScope, getCwd })` (reads a DSH-style skill registry, LLM-inferring predicates with a shared vocabulary — **no manual annotation needed**), or `frontmatterSource(files)` (parse `grasp:` blocks from SKILL.md).
- **Proposer** — who picks the nodes: `explicit`, `retrieval` (top-M fallback), `llm` (needs an `llmClient.complete({prompt, temperature})`).
- **Store** — where plans & episodic memory live: `memoryStore()` (in-process), `kvStore(storage)` (persistent).
- **Operators** — the repair algebra is a registry; register your own, reorder the default attempt order via `params.operatorOrder`.

## Verified against the paper

The apple demo reproduces the paper's confidence routing exactly: empty memory → **c_ret ≈ 0.4831** (boosted-repair) → record a successful episode → **≈ 0.9009** (full-dag) → unrelated task → **≈ 0.3248** (react-fallback, no DAG).

## Honest limitations

- The paper's hyperparameters (τ_low/τ_high/L_max/E_max/λ/η/k/M/h/R_max/P_max) come from Appendix C.1; the confidence weight vector `w=[1.2,1.0,0.8,1.8]` and bias `b=-2.0` are **our empirical choices** (the paper does not publish them).
- Predicates for prose skills are **LLM-inferred** — they are symbolic, not grounded in observable state. GraSP's formal compilation shines when skills have hand-written, consistent predicates (like ALFWorld); LLM-inferred ones are best-effort.
- Retrieval uses token Jaccard similarity, not embeddings (a natural extension point: inject a real `similarity` function).
- DAG compilation assumes acyclic plans; cyclic execution patterns are out of scope (the paper's own §6 boundary).

## License

MIT
