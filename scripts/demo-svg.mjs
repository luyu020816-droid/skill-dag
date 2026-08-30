// Render a sample GraSP DAG to a standalone SVG (for README / market screenshots).
// Matches the plugin's visual style. Run: node scripts/demo-svg.mjs > docs/demo-dag.svg
const DAG = {
  nodes: [
    { id: 'src', kind: 'src', name: 'START', x: 40, y: 30 },
    { id: 'brainstorming:1', kind: 'skill', name: 'brainstorming', args: ['task'],
      precondition: ['creative_task_requested(task)'],
      effect: ['requirements_defined(task)', 'design_defined(task)', 'implementation_ready(task)'], x: 340, y: 30 },
    { id: 'tdd:1', kind: 'skill', name: 'tdd', args: ['feature'],
      precondition: ['feature_requested(feature)'],
      effect: ['failing_test_written(feature)', 'implementation_passes(feature)', 'implementation_refactored(feature)'], x: 340, y: 146 },
    { id: 'snk', kind: 'snk', name: 'GOAL',
      precondition: ['design_defined(task)', 'failing_test_written(feature)'], x: 640, y: 30 },
  ],
  edges: [
    { from: 'src', to: 'brainstorming:1', type: 'order', label: 'start' },
    { from: 'src', to: 'tdd:1', type: 'order', label: 'start' },
    { from: 'brainstorming:1', to: 'snk', type: 'order', label: 'goal' },
    { from: 'tdd:1', to: 'snk', type: 'order', label: 'goal' },
  ],
  plan: ['brainstorming:1', 'tdd:1'],
  filtered: '2 of 47 skills kept',
  routing: { mode: 'full-dag-boosted-repair', confidence: 0.48 },
}

const STATUS_COLOR = { verified: '#16a34a', failed: '#dc2626', ready: '#eab308', executing: '#2563eb', pending: '#64748b', bypassed: '#86efac' }
const EDGE_STYLE = {
  state: { stroke: '#3b82f6', dash: '', w: 1.7 },
  data: { stroke: '#a855f7', dash: '5,4', w: 1.2 },
  order: { stroke: '#94a3b8', dash: '2,4', w: 1.1 },
}
const nodeW = 160, nodeH = 40
const byId = {}
DAG.nodes.forEach(n => { byId[n.id] = n })
let maxX = 260, maxY = 130
DAG.nodes.forEach(n => {
  maxX = Math.max(maxX, n.x + nodeW + 20)
  maxY = Math.max(maxY, n.y + nodeH + 20)
})

const markers = [
  '<marker id="ah-state" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#3b82f6"/></marker>',
  '<marker id="ah-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#a855f7"/></marker>',
  '<marker id="ah-order" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>',
].join('')

const edges = DAG.edges.map((e, i) => {
  const a = byId[e.from], b = byId[e.to]
  const x1 = a.x + nodeW, y1 = a.y + nodeH / 2
  const x2 = b.x, y2 = b.y + nodeH / 2
  const d = `M${x1},${y1} Q${(x1 + x2) / 2},${(y1 + y2) / 2} ${x2},${y2}`
  const st = EDGE_STYLE[e.type]
  return `<path d="${d}" fill="none" stroke="${st.stroke}" stroke-width="${st.w}" stroke-dasharray="${st.dash}" marker-end="url(#ah-${e.type})"/>`
}).join('\n    ')

const nodes = DAG.nodes.map(n => {
  const isTerm = n.kind === 'src' || n.kind === 'snk'
  const fill = isTerm ? '#334155' : STATUS_COLOR[n.status] || STATUS_COLOR.pending
  const detail = n.id + ' | pre: ' + (n.precondition || []).join(', ') + ' | eff: ' + (n.effect || []).join(', ')
  return `<g>
    <title>${detail}</title>
    <rect x="${n.x}" y="${n.y}" width="${nodeW}" height="${nodeH}" rx="8" fill="#0f172a" stroke="${fill}" stroke-width="2"/>
    <text x="${n.x + nodeW / 2}" y="${n.y + nodeH / 2 + 4}" fill="#f1f5f9" font-size="12" font-weight="600" text-anchor="middle" font-family="system-ui,sans-serif">${n.name}</text>
  </g>`
}).join('\n    ')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxX} ${maxY}" style="background:#020617;border-radius:8px">
  <defs>${markers}</defs>
  <g>
    ${edges}
    ${nodes}
  </g>
</svg>
`
console.log(svg)
