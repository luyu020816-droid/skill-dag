// Type declarations for skill-dag.

export interface Skill {
  id: string
  name: string
  description?: string
  params?: string[]
  precondition?: string[]
  effect?: string[]
  args?: string[]
  verifier?: unknown
  softVerify?: boolean
}

export interface DagNode {
  id: string
  kind: 'src' | 'skill' | 'snk'
  skill: string | null
  name: string
  args: string[]
  params: string[]
  precondition: string[]
  effect: string[]
  verifier: unknown
  status: string
  confidence: number
  repairBudget: number
  repairCount: number
  x?: number
  y?: number
}

export interface DagEdge {
  from: string
  to: string
  type: 'state' | 'data' | 'order'
  label: string
}

export interface Dag {
  planId: string
  task: string
  goal: string[]
  initial_conditions: string[]
  nodes: DagNode[]
  edges: DagEdge[]
  plan: string[]
  routing: { confidence: number | null; mode: string }
  retrieval?: { skills: string[]; features: Record<string, number> }
  filtered: string
  rejected: { skill: string; reason: string }[]
  params: Record<string, unknown>
}

export interface CompileInput {
  task?: string
  proposal?: { skill: string; args?: string[]; confidence?: number }[]
  goal?: string[]
  initialConditions?: string[]
  orderHints?: { from: string; to: string; label?: string }[]
}

export interface SkillSource {
  list(): Promise<Skill[]>
  get(id: string): Promise<Skill | null>
  skipped?(): { name: string; reason: string }[]
  inferred?(): number
}

export interface Proposer {
  propose(input: { task: string; skills: Skill[]; retrieval?: unknown; goal?: string[] }): Promise<{ skill: string; args?: string[]; confidence?: number }[]>
}

export interface Store {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
  keys(prefix?: string): Promise<string[]>
}

export interface GraspCore {
  params: Record<string, unknown>
  compile(input: CompileInput): Promise<{ ok: boolean; dag?: Dag; reason?: string; routing?: Dag['routing']; rejected?: { skill: string; reason: string }[] }>
  verify(planId: string, nodeId: string, before?: string[], after?: string[]): Promise<Record<string, unknown>>
  repair(planId: string, event: { nodeId: string; type: string; message?: string; state?: string[] }): Promise<Record<string, unknown>>
  retrieveOnly(task: string): Promise<Record<string, unknown>>
  route(confidence: number): { confidence: number; mode: string }
  record(input: { task: string; trajectory?: string[]; success?: boolean }): Promise<{ recorded: boolean; memorySize: number }>
  getPlan(planId: string): Promise<Dag | null>
  setParams(patch: Record<string, unknown>): Record<string, unknown>
}

export interface CreateGraspCoreOptions {
  params?: Record<string, unknown>
  skillSource: SkillSource
  proposer?: Proposer
  store?: Store
  llmClient?: { complete(input: { prompt: string; temperature?: number }): Promise<string> } | null
  operators?: Record<string, (ctx: Record<string, unknown>) => unknown>
}

export function createGraspCore(options: CreateGraspCoreOptions): GraspCore
export function memoryStore(): Store
export function manifestSource(manifest: { skills: Skill[]; goal?: string[]; initial_conditions?: string[] }): SkillSource
export function dshSkillsSource(skillsApi: unknown, opts?: { llmClient?: unknown; getScope?: () => unknown; getCwd?: () => string | undefined; ttlMs?: number }): SkillSource
export function frontmatterSource(files: { name: string; content: string }[]): SkillSource
export function createProposer(kind: 'explicit' | 'retrieval' | 'llm', opts?: Record<string, unknown>): Proposer
export function kvStore(storage: Record<string, unknown>, prefix?: string): Store
export function parseFrontmatter(text: string): Record<string, unknown> | null
export function parseInlineArray(inner: string): string[]
export function extractGraspMeta(obj: Record<string, unknown>): Record<string, unknown> | null
export function slug(s: string): string
export const DEFAULT_PARAMS: Record<string, unknown>
export const BUILTIN_OPERATORS: Record<string, (ctx: Record<string, unknown>) => unknown>
export const DEFAULT_ORDER: Record<string, string[]>
