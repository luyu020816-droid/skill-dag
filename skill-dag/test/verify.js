// Verification of the GraSP core against spec §7 expectations.
const {
  createGraspCore, memoryStore, manifestSource, frontmatterSource
} = require('../index.js')

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

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.log('  ✗ ' + label)
    console.log('    expected: ' + JSON.stringify(expected))
    console.log('    actual:   ' + JSON.stringify(actual))
  } else {
    console.log('  ✓ ' + label + '  → ' + JSON.stringify(actual))
  }
  return ok
}

async function main() {
  const core = createGraspCore({ skillSource: manifestSource(APPLE.manifest) })

  console.log('\n[1] compile (apple demo, 8 skills)')
  const res = await core.compile({
    task: APPLE.task,
    goal: APPLE.manifest.goal,
    initialConditions: APPLE.manifest.initial_conditions,
    proposal: APPLE.proposal
  })
  if (!res.ok) { console.log('  ✗ compile failed: ' + res.reason); process.exit(1) }
  const dag = res.dag
  check('filtered', dag.filtered, '5 of 8 skills kept')
  check('plan', dag.plan, ['find:1', 'open:1', 'pick:1', 'clean:1', 'put:1'])

  const stateEdges = dag.edges.filter(e => e.type === 'state').map(e => e.from + '→' + e.to).sort()
  check('state edges', stateEdges,
    ['find:1→pick:1', 'open:1→pick:1', 'pick:1→clean:1', 'pick:1→put:1'])
  const dataEdges = dag.edges.filter(e => e.type === 'data').map(e => e.from + '→' + e.to).sort()
  check('data edges', dataEdges,
    ['find:1→pick:1', 'pick:1→clean:1', 'pick:1→put:1'])

  check('c_ret (empty memory) mode', dag.routing.mode, 'full-dag-boosted-repair')
  const cEmpty = dag.routing.confidence
  console.log('    c_ret(empty) = ' + cEmpty.toFixed(4) + '  (expect ≈0.4831)')

  console.log('\n[2] verify clean:1 with missing precondition at(agent,sink)')
  const before = ['at(agent,fridge)', 'knows_loc(apple)', 'open(fridge)', 'holding(apple)']
  const after = ['clean(apple)']
  const v = await core.verify(dag.planId, 'clean:1', before, after)
  check('verify pass', v.pass, false)
  check('verify type', v.event.type, 'precondition')

  console.log('\n[3] repair → InsertPrereq inserts goto:1')
  const r = await core.repair(dag.planId, v.event)
  check('repair ok', r.ok, true)
  check('repair operator', r.patch.operator, 'InsertPrereq')
  check('repair addedNodes', r.patch.patch.addedNodes, ['goto:1'])
  check('repair addedEdges', r.patch.patch.addedEdges, 2)

  console.log('\n[4] boundedness: lMax=0 disables InsertPrereq')
  const core2 = createGraspCore({
    skillSource: manifestSource(APPLE.manifest),
    params: { lMax: 0 }
  })
  const res2 = await core2.compile({
    task: APPLE.task, goal: APPLE.manifest.goal,
    initialConditions: APPLE.manifest.initial_conditions, proposal: APPLE.proposal
  })
  const v2 = await core2.verify(res2.dag.planId, 'clean:1', before, after)
  const r2 = await core2.repair(res2.dag.planId, v2.event)
  check('lMax=0 → not repaired (escalate)', r2.repaired, false)
  console.log('    escalate = ' + r2.escalate)

  console.log('\n[5] hallucination guard: unknown skill + wrong arity rejected')
  const core3 = createGraspCore({ skillSource: manifestSource(APPLE.manifest) })
  const res3 = await core3.compile({
    task: APPLE.task, goal: APPLE.manifest.goal,
    initialConditions: APPLE.manifest.initial_conditions,
    proposal: [
      { skill: 'nonexistent', args: [] },
      { skill: 'find', args: ['apple', 'extra'] },
      { skill: 'open', args: [] },
      { skill: 'pick', args: ['apple'] },
      { skill: 'clean', args: ['apple'] },
      { skill: 'put', args: ['apple', 'countertop'] }
    ]
  })
  check('rejected', res3.dag.rejected,
    [{ skill: 'nonexistent', reason: 'unknown skill' }, { skill: 'find', reason: 'arity 2 != 1' }])

  console.log('\n[6] confidence routing: empty → record → unrelated')
  const core4 = createGraspCore({ skillSource: manifestSource(APPLE.manifest) })
  const cEmpty2 = (await core4.compile({ task: APPLE.task, goal: APPLE.manifest.goal, initialConditions: APPLE.manifest.initial_conditions, proposal: APPLE.proposal })).dag.routing.confidence
  await core4.record({ task: APPLE.task, trajectory: ['find', 'open', 'pick', 'goto', 'clean', 'put'], success: true })
  const res4 = await core4.compile({ task: APPLE.task, goal: APPLE.manifest.goal, initialConditions: APPLE.manifest.initial_conditions, proposal: APPLE.proposal })
  const cAfter = res4.dag.routing.confidence
  const cUnrelated = (await core4.retrieveOnly('unrelated cooking recipe')).confidence
  console.log('    empty     = ' + cEmpty2.toFixed(4) + ' (expect ≈0.4831, boosted-repair)')
  console.log('    after rec = ' + cAfter.toFixed(4) + ' (expect ≈0.9009, full-dag)  mode=' + res4.dag.routing.mode)
  console.log('    unrelated = ' + cUnrelated.toFixed(4) + ' (expect ≈0.3248, react-fallback)')

  console.log('\n[7] frontmatter extraction (with comma-inside-predicate bug check)')
  const fm = frontmatterSource([
    {
      name: 'clean-object',
      content: '---\nname: clean-object\ndescription: Clean an object\ngrasp:\n  params: [object]\n  precondition: ["holding(object)", "at(agent,sink)"]\n  effect: ["clean(object)"]\n---\nbody'
    },
    {
      name: 'no-grasp',
      content: '---\nname: no-grasp\ndescription: no grasp block\n---\nbody'
    }
  ])
  const skills = await fm.list()
  check('frontmatter precondition (multi-arg predicate intact)',
    skills[0].precondition, ['holding(object)', 'at(agent,sink)'])
  check('frontmatter skipped', fm.skipped(), [{ name: 'no-grasp', reason: 'no grasp: block' }])

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED ✓' : failures + ' CHECK(S) FAILED ✗'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
