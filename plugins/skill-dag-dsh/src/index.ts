// skill-dag-dsh — host half.
// Wires the skill-dag core to DeepSeek Harness: real LLM (agentDefaultModel +
// llm.stream), real session+workspace skills (scope + cwd), and model-visible
// GraSP tools (grasp_compile_task etc.). No manual skill annotation required.
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  createGraspCore, memoryStore, manifestSource, dshSkillsSource,
  createProposer,
} from 'skill-dag'

export const name = 'grasp'
export const inject = ['llm', 'skills', 'agents', 'agentDefaultModel']

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
      { id: 'put',   name: 'Put object',       params: ['object', 'loc'], precondition: ['holding(object)', 'at(agent,loc)'],  effect: ['on(object,loc)'] },
      { id: 'heat',  name: 'Heat object',      params: ['object'],        precondition: ['holding(object)'], effect: ['hot(object)'] },
      { id: 'slice', name: 'Slice object',     params: ['object'],        precondition: ['holding(object)'], effect: ['sliced(object)'] },
    ],
  },
  proposal: [
    { skill: 'find',  args: ['apple'] },
    { skill: 'open',  args: [] },
    { skill: 'pick',  args: ['apple'] },
    { skill: 'clean', args: ['apple'] },
    { skill: 'put',   args: ['apple', 'countertop'] },
    { skill: 'heat',  args: ['apple'] },
    { skill: 'slice', args: ['apple'] },
  ],
}

export function apply(ctx: Context): void {
  let currentScope: unknown = null
  let currentCwd: string | undefined

  // ---- real LLM: default model + streaming ----
  const llm = ctx.get('llm') as { stream(options: unknown): AsyncIterable<{ type: string; text?: string }> } | undefined
  const defaultModel = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined
  let llmClient: { complete(input: { prompt: string; temperature?: number }): Promise<string> } | null = null
  if (llm && defaultModel) {
    const sel = defaultModel.currentSelection()
    if (sel && sel.provider && sel.model) {
      llmClient = {
        async complete({ prompt, temperature }) {
          const messages = [{
            id: 'grasp-' + Date.now() + '-' + Math.random().toString(36).slice(2),
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'skill-dag-dsh' },
          }]
          let text = ''
          for await (const chunk of llm.stream({
            provider: sel.provider,
            model: sel.model,
            messages,
            temperature: typeof temperature === 'number' ? temperature : 0,
          })) {
            if (chunk.type === 'text-delta' && chunk.text) text += chunk.text
          }
          return text
        },
      }
    }
  }

  // ---- goal inference reusing skill effects (shared vocabulary) ----
  async function inferGoal(task: string, skills: Array<{ id: string; effect?: string[] }>): Promise<string[] | null> {
    if (!llmClient) return null
    const effects = (skills || []).map(s => '  - ' + s.id + ': ' + (s.effect || []).join('; ')).join('\n')
    const prompt = [
      'Decompose this task into goal predicates for a planning DAG.',
      'Task: ' + task,
      '',
      'Available skills and their effects:',
      effects || '  (none)',
      '',
      'A predicate is a first-order atom like "clean(object)".',
      'Return the goal predicates that must be TRUE after the task completes.',
      'Reuse the EXACT predicate NAMES and ARITY from the effects listed above.',
      'But BIND the variables to concrete values taken from the task text.',
      'Example: if a skill effect is "has_tests(feature)" and the task is about the login flow,',
      'the goal predicate must be "has_tests(login)" — same predicate name, concrete argument.',
      'Do NOT leave placeholder variable names such as "feature" or "object" in the goal.',
      'Reply with ONLY a JSON array, no prose: ["pred(...)", ...]',
    ].join('\n')
    try {
      const raw = await llmClient.complete({ prompt, temperature: 0 })
      const m = /\[[\s\S]*\]/.exec(String(raw || ''))
      if (!m) return null
      const arr = JSON.parse(m[0])
      if (!Array.isArray(arr) || !arr.length) return null
      return arr.map(String)
    } catch {
      return null
    }
  }

  // ---- skill source: real session+workspace skills, demo fallback ----
  const skillsApi = ctx.get('skills') as {
    list(options?: { scope?: unknown; cwd?: string }): Promise<Array<{ name: string }>>
    get(name: string, options?: { scope?: unknown; cwd?: string }): Promise<unknown>
  } | undefined
  const realSource = dshSkillsSource(skillsApi, { llmClient, getScope: () => currentScope, getCwd: () => currentCwd })
  const demoSource = manifestSource(APPLE.manifest)
  const skillSource = {
    list: async () => {
      const real = await realSource.list()
      return real.length ? real : demoSource.list()
    },
    get: async (id: string) => (await skillSource.list()).find((s: { id: string }) => s.id === id) || null,
    skipped: () => realSource.skipped(),
    inferred: () => realSource.inferred(),
    usingDemo: async () => (await realSource.list()).length === 0,
  }

  const core = createGraspCore({
    skillSource,
    proposer: createProposer(llmClient ? 'llm' : 'retrieval', { llmClient }),
    store: memoryStore(),
    llmClient,
  })

  // ---- model tools ----
  const OUT = { type: 'object', additionalProperties: true } as const
  const renderJson = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]
  // Tools return free-form JSON; defineTool's strict value inference rejects
  // Record<string, unknown> results (TS2321/TS2322), so relax at the boundary.
  // Runtime shape is unchanged (name/description/parameters/output/execute).
  const def = (toolDef: Record<string, unknown>) =>
    ctx.tools.register(defineTool(toolDef as never))

  def({
    name: 'grasp_compile_task',
    description: 'Compile a natural-language task into a DAG against the real skill library (session + workspace skills): jointly infer skill predicates with a shared vocabulary, infer the goal reusing those effects, retrieve, propose with the LLM (binding args to match the goal), and compile. No manual annotation required.',
    parameters: { task: { type: 'string', required: true, description: 'Natural-language task to compile into a DAG.' } },
    output: { schema: OUT, render: renderJson },
    async execute(args: { task: string }, exec: { agent?: { session?: { header?: { cwd?: string } } } }) {
      currentScope = (exec && exec.agent) || null
      currentCwd = (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || undefined
      const skills = await skillSource.list()
      if (!skills.length) return { ok: false, reason: 'no skills available' }
      const goal = await inferGoal(args.task, skills)
      if (!goal || !goal.length) return { ok: false, reason: 'could not infer goal predicates' }
      return core.compile({ task: args.task, goal, initialConditions: [] })
    },
  })

  def({
    name: 'grasp_compile',
    description: 'Compile the available skills into a typed executable DAG (GraSP-style). Runs memory-conditioned retrieval first; if confidence is low it returns a react-fallback with no DAG.',
    parameters: {
      task: { type: 'string', required: true, description: 'Task description (drives retrieval + routing).' },
      goal: { type: 'json', description: 'Goal predicates, e.g. ["clean(apple)"].' },
      initialConditions: { type: 'json', description: 'Predicates true at start.' },
      proposal: { type: 'json', description: 'Optional explicit node proposals [{skill, args}].' },
    },
    output: { schema: OUT, render: renderJson },
    async execute(args: Record<string, unknown>, exec: { agent?: { session?: { header?: { cwd?: string } } } }) {
      currentScope = (exec && exec.agent) || null
      currentCwd = (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || undefined
      return core.compile((args as never) || {})
    },
  })

  def({
    name: 'grasp_verify',
    description: 'Verify one executed DAG node: precondition against state-before, effect against state-after. Returns pass/fail plus a typed failure event.',
    parameters: {
      planId: { type: 'string', required: true },
      nodeId: { type: 'string', required: true },
      before: { type: 'json', description: 'True predicates before execution.' },
      after: { type: 'json', description: 'True predicates after execution.' },
    },
    output: { schema: OUT, render: renderJson },
    async execute(args: { planId: string; nodeId: string; before?: string[]; after?: string[] }) {
      return core.verify(args.planId, args.nodeId, args.before, args.after)
    },
  })

  def({
    name: 'grasp_repair',
    description: 'Apply a bounded local repair (typed operators) to a failed DAG node. Returns the repaired DAG plus the patch.',
    parameters: {
      planId: { type: 'string', required: true },
      event: { type: 'json', required: true, description: 'Failure event {nodeId, type, message, state}.' },
    },
    output: { schema: OUT, render: renderJson },
    async execute(args: { planId: string; event: never }) {
      return core.repair(args.planId, args.event)
    },
  })

  def({
    name: 'grasp_retrieve',
    description: 'Memory-conditioned skill retrieval (GraSP Eq.1/2): fuses direct semantic similarity with episodic memory, returns top-M skills, features and calibrated confidence. Pass goal predicates to get a meaningful coverage feature — without them confidence is inflated.',
    parameters: {
      task: { type: 'string', required: true },
      goal: { type: 'json', description: 'Goal predicates, e.g. ["clean(apple)"]. Improves coverage calibration.' },
    },
    output: { schema: OUT, render: renderJson },
    async execute(args: { task: string; goal?: string[] }) {
      return core.retrieveOnly(args.task, args.goal)
    },
  })

  def({
    name: 'grasp_record',
    description: 'Record an episode (task, skill trajectory, success) into the experience memory used by retrieval.',
    parameters: {
      task: { type: 'string', required: true },
      trajectory: { type: 'json', description: 'Ordered skill ids used.' },
      success: { type: 'boolean' },
    },
    output: { schema: OUT, render: renderJson },
    async execute(args: { task: string; trajectory?: string[]; success?: boolean }) {
      return core.record(args)
    },
  })

  def({
    name: 'grasp_status',
    description: 'Report GraSP plugin wiring: real skill library in use, skills skipped, LLM-inferred count, LLM availability, and current parameters.',
    parameters: {},
    output: { schema: OUT, render: renderJson },
    async execute() {
      return {
        usingDemo: await skillSource.usingDemo(),
        skipped: skillSource.skipped(),
        inferred: skillSource.inferred(),
        hasLLM: !!llmClient,
        persistent: false,
        params: core.params,
      }
    },
  })

  console.log('[grasp] host wired: llm=' + (llmClient ? 'on' : 'off') + ' skills=session+workspace')
}
