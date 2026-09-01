'use strict'
// 阶段 A 验收：持久化 Skill Library。
// 核心主张：Skill 内容未变化时，重启/重建 source 后复用持久化编译结果，不再调用 LLM；
// 内容变化后只重编译变化项（执行规格 §9.1）。
const assert = require('assert')
const { dshSkillsSource } = require('../index.js')

// 内存持久化 store（模拟 storageDomain 的 get/set）
function memPersist() {
  const m = new Map()
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { m.set(k, v) },
    _size: () => m.size,
    _keys: () => [...m.keys()],
  }
}

// 桩 skills API：list 返回名字，get 返回带 content 的 SkillDefinition
function skillsApi(skills) {
  const byName = {}
  skills.forEach(s => { byName[s.name] = s })
  return {
    list: async () => Object.keys(byName).map(name => ({ name, description: byName[name].description || '' })),
    get: async (name) => byName[name] || null,
  }
}

// 计数 LLM：每次 complete 调用 +1
function countingLLM() {
  let calls = 0
  return {
    calls: () => calls,
    complete: async ({ prompt }) => {
      calls++
      if (prompt.includes('MUST share one vocabulary')) {
        return JSON.stringify({
          'alpha': { params: ['feature'], precondition: [], effect: ['has_alpha(feature)'] },
          'beta':  { params: ['feature'], precondition: ['has_alpha(feature)'], effect: ['has_beta(feature)'] },
        })
      }
      return '{}'
    },
  }
}

const SKILLS = [
  { name: 'alpha', description: 'Alpha skill.', content: '# alpha\n\nbody alpha' },
  { name: 'beta',  description: 'Beta skill.',  content: '# beta\n\nbody beta' },
]

;(async () => {
  const persist = memPersist()

  // 第一次构建：无缓存 → 批量 LLM 调用一次
  const llm1 = countingLLM()
  const src1 = dshSkillsSource(skillsApi(SKILLS), { llmClient: llm1, persist })
  const out1 = await src1.list()
  assert.strictEqual(llm1.calls(), 1, 'first build must call LLM exactly once (batch)')
  assert.strictEqual(out1.length, 2, 'both skills compiled')
  assert.ok(persist._size() >= 2, 'compiled results must be persisted')
  console.log('  ok   first build: 1 batch LLM call, ' + persist._size() + ' persisted entries')

  // 第二次构建（模拟重启）：同内容 → 零 LLM 调用，复用持久化结果
  const llm2 = countingLLM()
  const src2 = dshSkillsSource(skillsApi(SKILLS), { llmClient: llm2, persist })
  const out2 = await src2.list()
  assert.strictEqual(llm2.calls(), 0, 'unchanged skills must NOT call LLM again')
  assert.deepStrictEqual(out2.map(s => s.id).sort(), ['alpha', 'beta'], 'same compiled skills')
  assert.deepStrictEqual(out2[0].effect, ['has_alpha(feature)'], 'persisted predicates reused')
  console.log('  ok   rebuild: 0 LLM calls — persistent reuse works')

  // 内容变化：只重编译变化项
  const llm3 = countingLLM()
  const changed = [{ ...SKILLS[0], content: '# alpha\n\nbody alpha v2' }, SKILLS[1]]
  const src3 = dshSkillsSource(skillsApi(changed), { llmClient: llm3, persist })
  const out3 = await src3.list()
  assert.strictEqual(llm3.calls(), 1, 'changed skill recompiled; unchanged skill reused')
  console.log('  ok   content change: 1 LLM call (only changed skill)')

  // 显式 grasp 元数据优先于持久化/LLM（§9.2）
  const llm4 = countingLLM()
  const explicit = [{
    name: 'alpha', description: 'Alpha.',
    content: '---\ngrasp:\n  params: [x]\n  precondition: ["p(x)"]\n  effect: ["q(x)"]\n---\nbody',
  }, SKILLS[1]]
  const src4 = dshSkillsSource(skillsApi(explicit), { llmClient: llm4, persist })
  const out4 = await src4.list()
  const alpha = out4.find(s => s.id === 'alpha')
  assert.deepStrictEqual(alpha.effect, ['q(x)'], 'explicit grasp metadata wins over persisted/LLM')
  console.log('  ok   explicit grasp metadata priority (effect=q(x))')

  console.log('\nstage A persistence: ALL PASSED')
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1) })
