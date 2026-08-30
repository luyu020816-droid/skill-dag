'use strict'
// 真实技能链路集成测试：散文描述、零 grasp: 标注，全靠 LLM 批量推断。
// 这条路径是 apple demo 覆盖不到的 —— 缺陷 1/2 只在这里发作。
const assert = require('assert')
const { createGraspCore, manifestSource, createProposer } = require('../index.js')

// 贴近真实 SKILL.md 的散文描述（无任何谓词标注）
const PROSE_SKILLS = [
  { name: 'domain-modeling', description: 'Build and sharpen a project domain model; pin down terminology.' },
  { name: 'prototype',       description: 'Build a throwaway prototype to answer a design question.' },
  { name: 'tdd',             description: 'Test-driven development; build features test-first.' },
  { name: 'code-review',     description: 'Review changes against repo standards and the originating spec.' },
]

// 桩 LLM：模拟一个「遵守共享词表规则」的模型。
const stubLLM = { complete: async ({ prompt }) => {
  if (prompt.includes('MUST share one vocabulary')) {
    return JSON.stringify({
      'domain-modeling': { params:['feature'], precondition:[],                         effect:['has_model(feature)'] },
      'prototype':       { params:['feature'], precondition:['has_model(feature)'],     effect:['has_prototype(feature)'] },
      'tdd':             { params:['feature'], precondition:['has_prototype(feature)'], effect:['has_tests(feature)'] },
      'code-review':     { params:['feature'], precondition:['has_tests(feature)'],     effect:['reviewed(feature)'] },
    })
  }
  if (prompt.includes('Decompose this task')) return '["reviewed(login)"]'
  if (prompt.includes('Propose the minimal')) {
    return JSON.stringify([
      { skill:'domain_modeling', args:['login'] }, { skill:'prototype', args:['login'] },
      { skill:'tdd', args:['login'] },             { skill:'code_review', args:['login'] },
    ])
  }
  return '{}'
}}

;(async () => {
  // 用批量推断的结果构造技能库（等价于 dshSkillsSource 修复后的产出）
  const batch = JSON.parse(await stubLLM.complete({ prompt: 'MUST share one vocabulary' }))
  const skills = PROSE_SKILLS.map(s => ({
    id: s.name.replace(/-/g, '_'), name: s.name, description: s.description,
    params: batch[s.name].params, precondition: batch[s.name].precondition,
    effect: batch[s.name].effect, args: []
  }))

  // 断言 1：共享词表下，effect ∩ precondition 必须非空（state 边的前提）
  const allEff = new Set(skills.flatMap(s => s.effect))
  const inter = [...new Set(skills.flatMap(s => s.precondition))].filter(p => allEff.has(p))
  assert.ok(inter.length >= 3, `expected >=3 shared predicates, got ${JSON.stringify(inter)}`)
  console.log('  ok   shared vocabulary: ' + inter.length + ' predicates chain skills together')

  const core = createGraspCore({ skillSource: manifestSource({ skills }),
    proposer: createProposer('llm', { llmClient: stubLLM }), llmClient: stubLLM })
  const r = await core.compile({ task: 'design and test the login flow',
    goal: ['reviewed(login)'], initialConditions: [] })

  // 断言 2：编译成功
  assert.ok(r.ok && r.dag, 'compile failed: ' + r.reason)
  console.log('  ok   compiled: ' + r.dag.plan.join(' → '))

  // 断言 3：必须产出真实依赖边（核心验收点）
  const st = r.dag.edges.filter(e => e.type === 'state')
  assert.ok(st.length >= 3, `expected >=3 state edges on real skills, got ${st.length}`)
  console.log('  ok   state edges: ' + st.length + ' — ' + st.map(e => e.from + '→' + e.to).join(', '))

  // 断言 4：顺序由依赖决定，不是照抄输入顺序
  const rev = await core.compile({ task: 'design and test the login flow',
    goal: ['reviewed(login)'], initialConditions: [],
    proposal: [...skills].reverse().map(s => ({ skill: s.id, args: ['login'] })) })
  assert.deepStrictEqual(rev.dag.plan, r.dag.plan,
    'plan changed when input order reversed → ordering is not dependency-driven')
  console.log('  ok   plan is dependency-driven (stable under reversed input)')

  // 断言 5：失败节点有真实后继（局部修复才有意义）
  const adj = {}; r.dag.nodes.forEach(n => { adj[n.id] = [] })
  r.dag.edges.filter(e => e.type !== 'order').forEach(e => { if (adj[e.from]) adj[e.from].push(e.to) })
  const first = r.dag.plan[0], seen = new Set(), q = [first]
  while (q.length) { const x = q.shift(); (adj[x]||[]).forEach(t => { if (!seen.has(t)) { seen.add(t); q.push(t) } }) }
  assert.ok(seen.size >= 2, `expected first node to have >=2 descendants, got ${seen.size}`)
  console.log('  ok   ' + first + ' has ' + seen.size + ' descendants — local repair is meaningful')

  // 断言 6：Rewire 不得在 precondition 缺失时假装修好
  const v = await core.verify(r.dag.planId, 'tdd:1', [], ['has_tests(login)'])
  assert.strictEqual(v.pass, false)
  const rep = await core.repair(r.dag.planId, v.event)
  if (rep.repaired) {
    assert.notStrictEqual(rep.patch.operator, 'Rewire',
      'Rewire must not claim success while a precondition is still missing')
  }
  console.log('  ok   no false repair (op=' + (rep.patch ? rep.patch.operator : rep.escalate) + ')')

  console.log('\nreal-skill integration: ALL PASSED')
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1) })
