// skill-dag-dsh — browser half.
// Renders the DAG returned by grasp_compile_task as a draggable inline SVG in
// the tool card (nodes show only names; args/pre/eff appear on hover).
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'grasp'
export const inject = ['slots']

const STATUS_COLOR: Record<string, string> = {
  verified: '#16a34a', failed: '#dc2626', ready: '#eab308',
  executing: '#2563eb', pending: '#64748b', bypassed: '#86efac',
}
const EDGE_STYLE: Record<string, { stroke: string; dash: string; w: number }> = {
  state: { stroke: '#3b82f6', dash: '', w: 1.7 },
  data: { stroke: '#a855f7', dash: '5,4', w: 1.2 },
  order: { stroke: '#94a3b8', dash: '2,4', w: 1.1 },
}

function arrow(id: string, color: string) {
  return React.createElement('marker',
    { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' },
    React.createElement('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }))
}

/** Draggable DAG view: nodes show only the name; details on hover (native title). */
function DAGView(props: { dag: unknown }) {
  const dag = props.dag as {
    nodes?: Array<Record<string, any>>; edges?: Array<Record<string, any>>
  } | null
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const dragRef = React.useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const [pan, setPan] = React.useState({ x: 0, y: 0 })

  if (!dag) return React.createElement('div', { style: { color: '#94a3b8', fontSize: 12 } }, 'No DAG (routed to ReAct fallback, or not compiled yet).')

  const nodes = dag.nodes || []
  const edges = dag.edges || []
  const byId: Record<string, any> = {}
  nodes.forEach(n => { byId[n.id] = n })
  const nodeW = 160, nodeH = 40
  let maxX = 260, maxY = 130
  nodes.forEach(n => {
    maxX = Math.max(maxX, (n.x || 0) + nodeW + 20)
    maxY = Math.max(maxY, (n.y || 0) + nodeH + 20)
  })

  function onMouseDown(e: React.MouseEvent) {
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y }
    e.preventDefault()
  }
  function onMouseMove(e: React.MouseEvent) {
    const d = dragRef.current
    if (!d) return
    const svg = svgRef.current
    const sx = svg ? maxX / (svg.clientWidth || 1) : 1
    const sy = svg ? maxY / (svg.clientHeight || 1) : 1
    setPan({ x: d.panX + (e.clientX - d.startX) * sx, y: d.panY + (e.clientY - d.startY) * sy })
  }
  function onMouseUp() { dragRef.current = null }

  const groups: Record<string, Array<Record<string, any>>> = {}
  edges.forEach(e => { const k = e.from + '|' + e.to; (groups[k] = groups[k] || []).push(e) })

  const edgeEls: React.ReactNode[] = []
  edges.forEach(function (e, i) {
    const a = byId[e.from], b = byId[e.to]
    if (!a || !b) return
    const grp = groups[e.from + '|' + e.to]
    const off = (grp.indexOf(e) - (grp.length - 1) / 2) * 26
    const x1 = (a.x || 0) + nodeW, y1 = (a.y || 0) + nodeH / 2
    const x2 = b.x || 0, y2 = (b.y || 0) + nodeH / 2
    const dx = x2 - x1, dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len, ny = dx / len
    const cx = (x1 + x2) / 2 + nx * off, cy = (y1 + y2) / 2 + ny * off
    const d = 'M' + x1 + ',' + y1 + ' Q' + cx + ',' + cy + ' ' + x2 + ',' + y2
    const st = EDGE_STYLE[e.type] || EDGE_STYLE.order
    const path = React.createElement('path', { key: 'p' + i, d, fill: 'none', stroke: st.stroke, strokeWidth: st.w, strokeDasharray: st.dash, markerEnd: 'url(#ah-' + e.type + ')' })
    let label = String(e.label || '')
    if (e.type === 'data') label = label.split(' → ')[0]
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
    const details = n.id
      + '\nargs: ' + ((n.args || []).join(', ') || '—')
      + '\npre: ' + ((n.precondition || []).join(', ') || 'none')
      + '\neff: ' + ((n.effect || []).join(', ') || '—')
    return React.createElement('g', { key: n.id },
      React.createElement('title', null, details),
      React.createElement('rect', { x, y, width: nodeW, height: nodeH, rx: 8, fill: '#0f172a', stroke: fill, strokeWidth: 2 }),
      React.createElement('text', { x: x + nodeW / 2, y: y + nodeH / 2 + 4, fill: '#f1f5f9', fontSize: 12, fontWeight: 600, textAnchor: 'middle' }, n.name || n.id))
  })

  const defs = React.createElement('defs', null,
    arrow('ah-state', '#3b82f6'), arrow('ah-data', '#a855f7'), arrow('ah-order', '#94a3b8'))

  return React.createElement('svg',
    { ref: svgRef, viewBox: '0 0 ' + maxX + ' ' + maxY, style: { background: '#020617', borderRadius: 8, display: 'block', width: '100%', height: 'auto', cursor: 'grab', touchAction: 'none', userSelect: 'none' }, onMouseDown, onMouseMove, onMouseUp, onMouseLeave: onMouseUp },
    defs, React.createElement('g', { transform: 'translate(' + pan.x + ' ' + pan.y + ')' }, edgeEls, nodeEls))
}

/** Tool-card view: render the DAG returned by grasp_compile_task as SVG inline in the chat. */
function GraspDagToolView(props: { block?: { content?: Array<{ type?: string; text?: string }> } }) {
  const block = props && props.block
  let text = ''
  if (block && block.content) {
    text = block.content.map(item => item && item.type === 'text' ? item.text : '').join('\n')
  }
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  const dag = parsed && parsed.dag ? parsed.dag : null
  const failReason = parsed && parsed.ok === false ? parsed.reason : null
  if (!dag) {
    return React.createElement('div', { style: { font: '12px/1.4 system-ui, sans-serif', color: '#e2e8f0', padding: 8, background: '#0f172a', border: '1px solid #334155', borderRadius: 8 } },
      failReason
        ? React.createElement('div', { style: { color: '#f87171' } }, failReason)
        : React.createElement('div', { style: { color: '#94a3b8' } }, 'No DAG compiled.'),
      React.createElement('pre', { style: { whiteSpace: 'pre-wrap', margin: '6px 0 0', color: '#94a3b8', fontSize: 11 } }, text))
  }
  const plan = (dag.plan || []).join(' → ')
  const routing = dag.routing && dag.routing.mode ? dag.routing.mode : ''
  const conf = dag.routing && typeof dag.routing.confidence === 'number' ? dag.routing.confidence.toFixed(2) : ''
  return React.createElement('div', { style: { font: '12px/1.4 system-ui, sans-serif', color: '#e2e8f0', padding: 8, background: '#0f172a', border: '1px solid #334155', borderRadius: 8 } },
    React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 } },
      React.createElement('b', null, 'GraSP DAG'),
      React.createElement('span', { style: { color: '#94a3b8' } }, dag.filtered || ''),
      React.createElement('span', { style: { color: '#7dd3fc' } }, routing + (conf ? ' c_ret=' + conf : ''))),
    plan ? React.createElement('div', { style: { marginBottom: 6, color: '#eab308' } }, 'plan: ' + plan) : null,
    React.createElement(DAGView, { dag: dag }))
}

export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as {
    inject(name: string, cb: () => unknown): unknown
  } | undefined
  if (!slots) return
  slots.inject('tool.call.toolview', () => {
    const reg = slots as unknown as {
      register(options: { name: string; key: string }, render: (props: unknown) => React.ReactNode): unknown
    }
    return reg.register({ name: 'tool.call.toolview', key: 'grasp_compile_task' }, (props) => React.createElement(GraspDagToolView, props || {}))
  })
}
