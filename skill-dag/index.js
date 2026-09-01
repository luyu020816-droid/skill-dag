// GraSP core — zero-harness-dependency compilation engine.
// Unofficial reproduction of "GraSP: Graph-Structured Skill Compositions for
// LLM Agents" (Tencent, arXiv:2604.17870). No `harness`, `ctx`, or `React` here.

const DEFAULT_PARAMS = {
  tauLow: 0.40,      // < this -> react-fallback
  tauHigh: 0.65,     // > this -> full-dag
  lMax: 3,           // max nodes a single repair patch may add
  eMax: 5,           // max edges a single repair patch may add
  lambda: 0.5,       // Eq.1 direct vs memory mixing weight
  eta: 0.7,          // Eq.2 learned vs historical weight
  k: 5,              // how many related memories to use
  m: 5,              // top-M skills handed to compilation
  h: 2,              // repair neighborhood radius (hop)
  rMax: 2,           // per-node repair budget
  pMax: 1,           // global replan budget per episode
  confWeights: [1.2, 1.0, 0.8, 1.8],  // confidence feature weights w
  confBias: -2.0,                      // confidence bias b
  verifyMode: 'strict',                // 'strict' | 'soft'
  operatorOrder: null                  // null = type-default order; otherwise explicit
}

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

function route(confidence, params) {
  const c = (typeof confidence === 'number') ? confidence : null
  if (c === null) return { confidence: c, mode: 'full-dag-boosted-repair' }
  if (c < params.tauLow) return { confidence: c, mode: 'react-fallback' }
  if (c > params.tauHigh) return { confidence: c, mode: 'full-dag' }
  return { confidence: c, mode: 'full-dag-boosted-repair' }
}

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
      u.effect.forEach(e => {
        if (v.precondition.indexOf(e) >= 0) add(u.id, v.id, 'state', e)
      })
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

async function compileWith(deps, { task, proposal, goal, initialConditions, orderHints }) {
  const { params, skillSource, proposer, store } = deps
  const P = params

  const skills = await skillSource.list()
  if (!skills.length) return { ok: false, reason: 'skill source returned no skills' }
  const byId = {}
  skills.forEach(s => { byId[s.id] = s })

  const goalList = goal || []
  const initial = initialConditions || []

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
      effectiveProposal = await proposer.propose({ task, skills, retrieval: ret, goal: goalList })
    }
  }

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

  // Fallback goal normalization: if a goal predicate still carries unbound
  // parameter names (e.g. "has_tests(feature)") while nodes were bound to
  // concrete values (e.g. "has_tests(login)"), rebind it to the node's
  // concrete predicate. LLM goal inference may otherwise disagree with
  // proposal binding and fail the completeness check below. Only triggers
  // when EVERY goal argument is a known parameter name, so explicit goals
  // are never rewritten.
  const paramNames = new Set()
  skills.forEach(s => (s.params || []).forEach(p => paramNames.add(p)))
  const normalizedGoal = goalList.map(g => {
    if (nodes.some(n => n.effect.indexOf(g) >= 0)) return g
    const gp = parsePred(g)
    if (!gp) return g
    for (const n of nodes) {
      for (const e of n.effect) {
        const ep = parsePred(e)
        if (!ep || ep.name !== gp.name || ep.args.length !== gp.args.length) continue
        if (gp.args.every(a => paramNames.has(a))) return e
      }
    }
    return g
  })

  const f = backwardFilter(nodes, normalizedGoal, initial)
  const keptCount = nodes.filter(n => f.kept.has(n.id)).length
  nodes = nodes.filter(n => f.kept.has(n.id))
  if (!nodes.length) return { ok: false, reason: 'goal unreachable: no skill covers goal', rejected }

  let edges = inferEdges(nodes, orderHints)
  const hard = edges.filter(e => e.type !== 'order')
  const soft = edges.filter(e => e.type === 'order')
  if (hasCycle(nodes, hard)) return { ok: false, reason: 'cycle among hard edges', rejected }
  edges = hard.slice()
  soft.slice().sort((a, b) => (a.confidence || 0) - (b.confidence || 0)).forEach(e => {
    if (!hasCycle(nodes, edges.concat([e]))) edges.push(e)
  })

  const src = { id: 'src', kind: 'src', skill: null, name: 'START', args: [], precondition: [], effect: initial.slice(), status: 'verified', confidence: 1 }
  const snk = { id: 'snk', kind: 'snk', skill: null, name: 'GOAL', args: [], precondition: normalizedGoal.slice(), effect: [], status: 'pending', confidence: 1 }
  const all = [src].concat(nodes).concat([snk])

  const hardIn = {}
  all.forEach(n => { hardIn[n.id] = 0 })
  edges.forEach(e => { if (e.to in hardIn) hardIn[e.to]++ })
  nodes.forEach(n => { if (hardIn[n.id] === 0) edges.push({ from: 'src', to: n.id, type: 'order', label: 'start' }) })
  const hasOut = {}
  nodes.forEach(n => { hasOut[n.id] = false })
  edges.forEach(e => { if (e.from in hasOut) hasOut[e.from] = true })
  nodes.forEach(n => {
    if (!hasOut[n.id] || n.effect.some(e => normalizedGoal.indexOf(e) >= 0)) {
      edges.push({ from: n.id, to: 'snk', type: 'order', label: 'goal' })
    }
  })

  if (hasCycle(all, edges)) return { ok: false, reason: 'cycle after structural edges', rejected }
  if (!reachable('src', 'snk', all, edges)) return { ok: false, reason: 'src to snk unreachable', rejected }
  const uncovered = normalizedGoal.filter(g =>
    !(initial.indexOf(g) >= 0 || nodes.some(n => n.effect.indexOf(g) >= 0)))
  if (uncovered.length) return { ok: false, reason: 'goal completeness failed: ' + uncovered.join(', '), rejected }

  const skillEdges = edges.filter(e => e.from !== 'src' && e.to !== 'snk')
  const plan = topoOrder(nodes, skillEdges)
  if (!plan) return { ok: false, reason: 'no valid topological order', rejected }
  layoutNodes(all, edges)

  const planId = 'plan_' + (await nextSeq(store))
  const dag = {
    planId, task: task || '',
    goal: normalizedGoal, initial_conditions: initial,
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

async function nextSeq(store) {
  const cur = (await store.get('meta:seq')) || 0
  const next = cur + 1
  await store.set('meta:seq', next)
  return next
}

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

async function verifySoft(node, before, after, llmClient) {
  if (!llmClient) return null
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

  Rewire({ dag, node, event }) {
    // Rewire only fixes redundant ORDER constraints; it cannot conjure up
    // missing predicates. If the failure is a missing precondition, deleting
    // an order edge helps nothing — yield to the other operators instead of
    // burning the repair budget on a fake success.
    if (event && event.type === 'precondition') {
      const state = event.state || []
      const missing = node.precondition.filter(p =>
        state.indexOf(p) < 0 && (dag.initial_conditions || []).indexOf(p) < 0)
      if (missing.length) return null
    }
    const idx = dag.edges.findIndex(e => e.to === node.id && e.type === 'order')
    if (idx < 0) return null
    dag.edges.splice(idx, 1)
    return { operator: 'Rewire', patch: { removedEdges: 1 }, bounded: true }
  }
}

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

function createGraspCore(options) {
  const opts = options || {}
  const params = Object.assign({}, DEFAULT_PARAMS, opts.params || {})
  const deps = {
    params,
    skillSource: opts.skillSource,
    proposer: opts.proposer || { propose: async ({ retrieval, skills }) => {
      const byId = {}; skills.forEach(s => { byId[s.id] = s })
      return (retrieval ? retrieval.skills : []).map(id => ({ skill: id, args: byId[id].args || [] }))
    } },
    store: opts.store || memoryStore(),
    llmClient: opts.llmClient || null,
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
    async retrieveOnly(task, goal) {
      const skills = await deps.skillSource.list()
      const episodes = (await deps.store.get('memory:episodes')) || []
      return retrieve({ skills, goal: goal || [], task, episodes, params })
    },
    route(confidence) { return route(confidence, params) },
    async record({ task, trajectory, success }) {
      const episodes = (await deps.store.get('memory:episodes')) || []
      episodes.push({ task: task || '', trajectory: Array.isArray(trajectory) ? trajectory : [], success: success ? 1 : 0 })
      await deps.store.set('memory:episodes', episodes)
      return { recorded: true, memorySize: episodes.length }
    },
    async getPlan(planId) { return deps.store.get('plan:' + planId) },
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

// ---- Adapters ----

function manifestSource(manifest) {
  const skills = (manifest && manifest.skills) || []
  return {
    list: async () => skills,
    get: async (id) => skills.find(s => s.id === id) || null,
    meta: { goal: (manifest && manifest.goal) || [], initial: (manifest && manifest.initial_conditions) || [] }
  }
}

function dshSkillsSource(skillsApi, opts) {
  const o = opts || {}
  const llmClient = o.llmClient || null
  const cache = { at: 0, val: null, skipped: [], inferred: 0, scope: undefined }
  const TTL = o.ttlMs || 5000
  // Optional persistent store ({ get(key) -> value | null, set(key, value) -> Promise }).
  // Compiled (LLM-inferred) skill definitions are cached by content hash so a
  // restart does not re-run the LLM for unchanged skills (execution spec §9.1).
  const persist = o.persist || null

  // Stable, dependency-free content hash (FNV-1a 32-bit, hex).
  function contentHash(text) {
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = (h * 0x01000193) >>> 0
    }
    return h.toString(16)
  }

  const persistKey = (name, hash) => 'grasp:compiled:' + name + ':' + hash

  async function loadPersisted(name, hash) {
    if (!persist) return null
    try {
      const raw = await persist.get(persistKey(name, hash))
      return raw || null
    } catch (e) {
      return null
    }
  }

  async function savePersisted(name, hash, g) {
    if (!persist) return
    try { await persist.set(persistKey(name, hash), g) } catch (e) { /* best-effort */ }
  }

  // Infer `grasp:` predicates from a prose skill description via the LLM.
  async function inferGrasp(name, description, whenToUse) {
    if (!llmClient) return null
    const prompt = [
      'Annotate a skill for graph-based planning.',
      'Name: ' + name,
      'Description: ' + (description || ''),
      'When to use: ' + (whenToUse || ''),
      '',
      'Infer typed predicates for a planning DAG:',
      '- params: free variables/arguments this skill operates on (e.g. ["object"])',
      '- precondition: predicates that must be true before running (e.g. ["holding(object)"])',
      '- effect: predicates that become true after running (e.g. ["clean(object)"])',
      '',
      'Reply with ONLY one JSON object, no prose:',
      '{"params":["..."],"precondition":["..."],"effect":["..."]}'
    ].join('\n')
    try {
      const raw = await llmClient.complete({ prompt, temperature: 0 })
      const m = /{[\s\S]*}/.exec(String(raw || ''))
      if (!m) return null
      const obj = JSON.parse(m[0])
      const pre = Array.isArray(obj.precondition) ? obj.precondition.map(String) : []
      const eff = Array.isArray(obj.effect) ? obj.effect.map(String) : []
      if (!pre.length && !eff.length) return null
      return {
        name: name,
        description: description,
        params: Array.isArray(obj.params) ? obj.params.map(String) : [],
        precondition: pre,
        effect: eff,
        args: [],
        softVerify: undefined
      }
    } catch (e) {
      return null
    }
  }

  // Batch inference: all skills annotated in ONE prompt so they share a
  // vocabulary and parameter names. Per-skill inference produces disjoint
  // predicate sets (effect ∩ precondition = ∅), so the DAG gets zero
  // state/data edges — this is the fix for that.
  async function inferGraspBatch(items) {
    if (!llmClient || !items.length) return {}
    const catalog = items.map((it, i) =>
      (i + 1) + '. ' + it.name +
      '\n   description: ' + (it.description || '(none)') +
      '\n   when to use: ' + (it.whenToUse || '(none)')
    ).join('\n')
    const prompt = [
      'Annotate a set of agent skills for graph-based planning.',
      'These skills will be compiled into a dependency DAG, so they MUST share one vocabulary.',
      '',
      'Skills:',
      catalog,
      '',
      'For EVERY skill infer:',
      '- params: free variables it operates on',
      '- precondition: predicates that must hold before running',
      '- effect: predicates that become true after running',
      '',
      'CRITICAL RULES — the plan cannot compile unless you follow these:',
      '1. Use ONE shared parameter name across all skills for the same kind of subject',
      '   (e.g. always "feature", never a mix of "feature"/"change"/"design").',
      '2. When skill B naturally runs after skill A, B.precondition MUST contain a',
      '   predicate string that is CHARACTER-IDENTICAL to one in A.effect.',
      '   Example of a correct chain:',
      '     design:  precondition=[]                        effect=["has_design(feature)"]',
      '     build:   precondition=["has_design(feature)"]   effect=["has_impl(feature)"]',
      '     test:    precondition=["has_impl(feature)"]     effect=["has_tests(feature)"]',
      '3. Predicates are first-order atoms: lowercase_name(arg) or lowercase_name(arg1,arg2).',
      '4. Prefer chaining skills through shared predicates over leaving preconditions empty.',
      '',
      'Reply with ONLY one JSON object keyed by skill name, no prose:',
      '{"<skill-name>":{"params":["..."],"precondition":["..."],"effect":["..."]}, ...}'
    ].join('\n')
    try {
      const raw = await llmClient.complete({ prompt, temperature: 0 })
      const m = /{[\s\S]*}/.exec(String(raw || ''))
      if (!m) return {}
      const obj = JSON.parse(m[0])
      const out = {}
      for (const it of items) {
        const g = obj[it.name]
        if (!g) continue
        const pre = Array.isArray(g.precondition) ? g.precondition.map(String) : []
        const eff = Array.isArray(g.effect) ? g.effect.map(String) : []
        if (!pre.length && !eff.length) continue
        out[it.name] = {
          name: it.name, description: it.description,
          params: Array.isArray(g.params) ? g.params.map(String) : [],
          precondition: pre, effect: eff, args: [], softVerify: undefined
        }
      }
      return out
    } catch (e) {
      return {}
    }
  }

  async function load() {
    if (!skillsApi) return []
    const scope = (typeof o.getScope === 'function') ? o.getScope() : undefined
    const cwd = (typeof o.getCwd === 'function') ? o.getCwd() : undefined
    const lookup = {}
    if (scope) lookup.scope = scope
    if (cwd) lookup.cwd = cwd
    if (cache.val && Date.now() - cache.at < TTL && cache.scope === scope) return cache.val
    const listed = await skillsApi.list(lookup)
    const out = []
    const skipped = []
    let inferred = 0

    // Pass 1: read every skill; split into explicit-annotation vs need-inference.
    const needInfer = []
    const resolved = []
    for (const item of listed) {
      const full = (await skillsApi.get(item.name, lookup)) || item
      const content = (full && full.content) || ''
      const fm = parseFrontmatter(content)
      // 1) explicit `grasp:` frontmatter wins; else it goes to batch inference.
      const g = extractGraspMeta(fm || full)
      if (g) {
        resolved.push({ item, full, g })
      } else {
        needInfer.push({
          item, full,
          name: item.name,
          description: (full && full.description) || '',
          whenToUse: (full && full.whenToUse) || ''
        })
      }
    }

    // Pass 2: ONE batch LLM call over all unannotated skills (shared vocabulary).
    // Persistent cache first: a skill whose content hash is unchanged reuses the
    // previously compiled definition (no LLM call). Only genuinely new/changed
    // skills go to the LLM, and their results are written back.
    let batch = {}
    if (needInfer.length && llmClient) {
      const fresh = []
      for (const n of needInfer) {
        const hash = contentHash((n.full && n.full.content) || n.name + n.description)
        const cached = await loadPersisted(n.name, hash)
        if (cached) { batch[n.name] = cached } else { fresh.push({ ...n, hash }) }
      }
      if (fresh.length) {
        const inferredBatch = await inferGraspBatch(fresh)
        for (const n of fresh) {
          const g = inferredBatch[n.name]
          if (g) await savePersisted(n.name, n.hash, g)
        }
        Object.assign(batch, inferredBatch)
      }
    }
    for (const n of needInfer) {
      let g = batch[n.name]
      if (!g && llmClient && Object.keys(batch).length === 0) {
        const inf = await inferGrasp(n.name, n.description, n.whenToUse)
        if (inf) g = inf
      }
      if (g) { resolved.push({ item: n.item, full: n.full, g }); inferred++ }
      else { skipped.push({ name: n.item.name, reason: 'no grasp metadata' }) }
    }

    // Pass 3: unified output.
    for (const r of resolved) {
      out.push({
        id: slug(r.item.name),
        name: (r.full && (r.full.name || r.full.title)) || r.item.name,
        description: (r.full && r.full.description) || '',
        params: r.g.params || [],
        precondition: r.g.precondition || [],
        effect: r.g.effect || [],
        args: r.g.args || [],
        softVerify: r.g.softVerify !== false
      })
    }
    cache.val = out
    cache.at = Date.now()
    cache.scope = scope
    cache.skipped = skipped
    cache.inferred = inferred
    return out
  }

  return {
    list: load,
    get: async (id) => (await load()).find(s => s.id === id) || null,
    skipped: () => cache.skipped || [],
    inferred: () => cache.inferred || 0
  }
}

function frontmatterSource(files) {
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

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
}

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
  const pre = g.precondition || [], eff = g.effect || []
  if (!pre.length && !eff.length) return null
  return {
    name: obj.name, description: obj.description,
    params: g.params || [], precondition: pre, effect: eff,
    args: g.args || [], softVerify: g.softVerify
  }
}

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
      const { task, skills, goal } = input
      const catalog = skills.map(s =>
        '- ' + s.id + '(' + (s.params || []).join(', ') + ')'
        + '  pre=[' + (s.precondition || []).join('; ') + ']'
        + '  eff=[' + (s.effect || []).join('; ') + ']').join('\n')
      const prompt = [
        'Task: ' + task,
        (goal && goal.length ? 'Goal predicates (must hold at the end): ' + goal.join(', ') : ''),
        '', 'Available skills:', catalog,
        '', 'Propose the minimal ordered set of skill invocations to accomplish the task.',
        'Bind every parameter to a concrete value.',
        (goal && goal.length
          ? 'Bind arguments so that the skills\' effects EXACTLY match the goal predicates (same predicate names AND values — reuse the argument names appearing inside the goal predicates).'
          : ''),
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
        return fallback.propose(input)
      }
    } }
  }
  throw new Error('unknown proposer kind: ' + kind)
}

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

// ---- Execution layer (spec §10-§12): scheduler-owned node state machine ----

const NODE_STATUSES = ['pending', 'ready', 'running', 'verifying', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome-unknown']
const PLAN_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled']

// Allowed transitions per current status. The scheduler is the ONLY writer.
const NODE_TRANSITIONS = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['verifying', 'failed', 'outcome-unknown', 'cancelled'],
  verifying: ['succeeded', 'failed', 'outcome-unknown', 'cancelled'],
  succeeded: [],                    // immutable without an explicit retry attempt
  failed: ['ready'],                // after repair / retry decision
  blocked: ['ready', 'cancelled'],  // a blocked successor may become ready if the failed branch is repaired
  cancelled: [],
  'outcome-unknown': ['ready'],     // inspect() resolved it, or explicit new attempt
}

function assertTransition(nodeId, from, to) {
  const allowed = NODE_TRANSITIONS[from]
  if (!allowed || allowed.indexOf(to) < 0) {
    throw new Error('invalid node transition ' + from + ' -> ' + to + ' (node ' + nodeId + ')')
  }
}

function stableIdempotencyKey(planId, nodeId, attempt) {
  // Deterministic, not random: recovery reuses the SAME key for the same attempt
  // so a side effect is never applied twice (spec §16).
  return 'grasp:idem:' + planId + ':' + nodeId + ':' + attempt
}

function makeExecutionPlan(compiled, id, version) {
  const now = new Date().toISOString()
  const nodes = {}
  const edges = (compiled && compiled.edges) || []
  const skills = (compiled && compiled.nodes) || []
  skills.forEach((n, i) => {
    const nid = n.id || ('n' + (i + 1))
    nodes[nid] = {
      id: nid, skillId: n.skill, args: (n.args || []).slice(),
      preconditions: (n.precondition || []).slice(),
      expectedEffects: (n.effect || []).slice(),
      status: 'pending', attempt: 0,
      idempotencyKey: null, evidence: [], output: null, failure: null,
    }
  })
  return {
    id, version: version || 1, task: (compiled && compiled.task) || '',
    status: 'pending', nodes, edges: edges.map(e => ({ from: e.from, to: e.to, type: e.type, label: e.label })),
    createdAt: now, updatedAt: now,
  }
}

function planSnapshot(plan) {
  return {
    id: plan.id, version: plan.version, task: plan.task, status: plan.status,
    nodes: Object.fromEntries(Object.entries(plan.nodes).map(([k, n]) => [k, {
      id: n.id, skillId: n.skillId, args: n.args, preconditions: n.preconditions,
      expectedEffects: n.expectedEffects, status: n.status, attempt: n.attempt,
      idempotencyKey: n.idempotencyKey, evidence: n.evidence, output: n.output, failure: n.failure,
    }])),
    edges: plan.edges, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
  }
}

// Nodes whose prerequisites are all succeeded (or that have no prerequisites).
function readyNodes(plan) {
  const preds = {}
  plan.edges.forEach(e => { (preds[e.to] = preds[e.to] || []).push(e.from) })
  return Object.keys(plan.nodes).filter(id => {
    const n = plan.nodes[id]
    if (n.status !== 'pending' && n.status !== 'ready') return false
    const deps = preds[id] || []
    return deps.every(d => {
      const dn = plan.nodes[d]
      return dn && dn.status === 'succeeded'
    })
  })
}

function isGoalReached(plan) {
  const hasOut = {}
  plan.edges.forEach(e => { hasOut[e.from] = true })
  const goalNodes = Object.keys(plan.nodes).filter(id => !hasOut[id])
  // A plan succeeds when every node that feeds no successor is succeeded
  // (mirrors the compiled DAG's snk reachability).
  return goalNodes.length > 0 && goalNodes.every(id => plan.nodes[id].status === 'succeeded')
}

// Block all pending/ready descendants of a failed node (spec §12.1).
function blockDescendants(plan, failedId) {
  const adj = {}
  plan.edges.forEach(e => { (adj[e.from] = adj[e.from] || []).push(e.to) })
  const stack = [failedId]
  const visited = new Set()
  while (stack.length) {
    const cur = stack.pop()
    if (visited.has(cur)) continue
    visited.add(cur)
    const n = plan.nodes[cur]
    if (n && (n.status === 'pending' || n.status === 'ready')) n.status = 'blocked'
    ;(adj[cur] || []).forEach(t => stack.push(t))
  }
}

// Verify one node after execution using the injected verifier; falls back to a
// structural check when no verifier is provided (spec §14).
async function verifyNodeResult(plan, node, verifier, executorResult) {
  if (verifier) {
    return verifier({ plan, node, output: executorResult })
  }
  const passed = !executorResult.error
  return {
    passed,
    observedEffects: passed ? node.expectedEffects.slice() : [],
    evidence: [], reason: passed ? undefined : String(executorResult.error || 'executor failed'),
  }
}

/**
 * Create a plan executor. Pure core: the scheduler owns every node transition;
 * executors and verifiers are injected by the host adapter and only RETURN
 * results — they never write node status (spec §12, §24.3).
 *
 * @param {object} deps
 * @param {Function} deps.execute   - (node, ctx) => Promise<{output?, error?}>; one node -> one execution
 * @param {Function} [deps.verify]  - (req) => Promise<{passed, observedEffects?, evidence?, reason?}>
 * @param {Function} [deps.persist] - (plan) => Promise<void>; durable write after every state change
 * @param {object}  [deps.params]   - { rMax?, timeoutMs? }
 */
function createExecutor(deps) {
  const execute = deps.execute
  if (typeof execute !== 'function') throw new Error('createExecutor: execute is required')
  const verify = deps.verify || null
  const persist = deps.persist || null
  const params = deps.params || {}
  const rMax = params.rMax || 2

  async function commit(plan) {
    plan.updatedAt = new Date().toISOString()
    if (persist) await persist(plan)
  }

  async function setNode(plan, node, to) {
    assertTransition(node.id, node.status, to)
    node.status = to
    if (to === 'running') {
      node.attempt++
      node.idempotencyKey = stableIdempotencyKey(plan.id, node.id, node.attempt)
    }
    await commit(plan)
  }

  // Run one node: ready -> running -> verifying -> succeeded/failed.
  async function runNode(plan, node, runCtx) {
    await setNode(plan, node, 'running')
    let result
    try {
      result = await execute({ node, plan, idempotencyKey: node.idempotencyKey }, runCtx)
    } catch (e) {
      result = { error: String(e && e.message || e) }
    }
    // Persist raw result + evidence before verification (spec §16).
    node.output = (result && 'output' in result) ? result.output : null
    if (result && Array.isArray(result.evidence)) node.evidence = result.evidence
    await commit(plan)

    await setNode(plan, node, 'verifying')
    const verdict = await verifyNodeResult(plan, node, verify, result || {})
    node.evidence = node.evidence.concat(verdict.evidence || [])
    if (verdict.passed) {
      await setNode(plan, node, 'succeeded')
      return { node, ok: true }
    }
    node.failure = {
      type: 'verification', message: verdict.reason || 'verification failed',
      state: verdict.observedEffects || [],
    }
    await setNode(plan, node, 'failed')
    return { node, ok: false, failure: node.failure }
  }

  /**
   * Run a plan serially (spec §12.1, §17: v1 is serial only).
   * @returns final snapshot
   */
  async function run(plan, runCtx) {
    plan.status = 'running'
    await commit(plan)
    let guard = 0
    const maxSteps = (Object.keys(plan.nodes).length + 1) * (rMax + 2)
    while (guard++ < maxSteps) {
      if (isGoalReached(plan)) { plan.status = 'succeeded'; await commit(plan); break }
      const ready = readyNodes(plan)
      if (!ready.length) {
        // No ready node and goal not reached: either blocked or exhausted.
        const anyFailed = Object.keys(plan.nodes).some(id => plan.nodes[id].status === 'failed')
        const anyBlocked = Object.keys(plan.nodes).some(id => plan.nodes[id].status === 'blocked')
        plan.status = anyFailed || anyBlocked ? 'failed' : plan.status
        await commit(plan)
        break
      }
      // Serial: pick the first ready node in deterministic (plan) order.
      const node = plan.nodes[ready[0]]
      if (node.status === 'pending') await setNode(plan, node, 'ready')
      const outcome = await runNode(plan, node, runCtx)
      if (!outcome.ok) {
        blockDescendants(plan, node.id)
        await commit(plan)
        plan.status = 'failed'
        await commit(plan)
        break
      }
    }
    return planSnapshot(plan)
  }

  async function cancel(plan, runCtx) {
    if (runCtx && typeof runCtx.cancel === 'function') runCtx.cancel()
    Object.keys(plan.nodes).forEach(id => {
      const n = plan.nodes[id]
      if (n.status === 'pending' || n.status === 'ready' || n.status === 'running' || n.status === 'verifying') {
        n.status = 'cancelled'
      }
    })
    plan.status = 'cancelled'
    await commit(plan)
    return planSnapshot(plan)
  }

  async function resume(plan, runCtx) {
    plan.status = 'running'
    await commit(plan)
    return run(plan, runCtx)
  }

  return { makeExecutionPlan, run, cancel, resume, snapshot: planSnapshot, readyNodes, isGoalReached, NODE_STATUSES, PLAN_STATUSES }
}

module.exports = {
  createGraspCore, memoryStore, DEFAULT_PARAMS, BUILTIN_OPERATORS, DEFAULT_ORDER,
  manifestSource, dshSkillsSource, frontmatterSource, createProposer, kvStore,
  parseFrontmatter, parseInlineArray, extractGraspMeta, slug,
  createExecutor, stableIdempotencyKey
}
