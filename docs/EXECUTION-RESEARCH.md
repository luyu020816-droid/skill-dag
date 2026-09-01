# Execution Layer — Interface Research

> Research baseline: `8b4ada7` (code) + execution spec review.
> Question answered: do the DSH services the execution spec needs (`ctx.subagents`,
> `ctx.storageDomain`, `ctx.skills`) exist, and are they mounted in the web profile?

## 1. `ctx.subagents` — CONFIRMED, mounted

Package group `packages/subagent`:
- `@deepseek-ai/dsh-subagent` — service contract, provider registry, one-shot + continuable
  children, interrupt, discovery. Mounted in web profile as `subagent`.
- `@deepseek-ai/dsh-subagent-spawn-in-process` — fresh in-process child, provider name
  `spawn`. Mounted.
- `@deepseek-ai/dsh-subagent-fork-in-process` — child seeded from parent history. Mounted.
- Others: `subagent-acp`, `subagent-codex`, `subagent-claude-code`, `subagent-dsh-sdk`
  (out-of-process backends, not required for v1).

### Start request (one-shot)

```ts
interface SubagentStartRequest {
  label?: string
  prompt: ContentBlock[]          // child's user message
  parent: Agent                   // cwd/lineage/depth derived from durable session
  signal: AbortSignal             // canonical cancellation, pre- and post-start
  agentOptions?: AgentOptions     // provider/model/effort/token overrides (capability-gated)
  outputSchema?: ObjectJsonSchema // child returns matching structured value
  maxDepth?: number               // delegation depth cap (capability-gated)
  toolFilter?: ToolRestriction    // tools.restrict(): vanish from prompt AND refuse execution
  persona?: string                // per-child persona shadowing deployment
}
```

### Result

```ts
interface SubagentResult {
  output: ContentBlock[]          // final assistant output
  structured?: unknown            // value matching outputSchema
  stopReason: 'completed'|'aborted'|'error'|'max-tokens'|'refusal'|string
  diagnostic?: string             // safe failure diagnostic
}
```

### Relevance to execution spec

- `toolFilter` implements §13 capability restrictions (filesystem/shell/network/externalWrite
  as named tool allow/deny sets) — one visibility: tools vanish from child prompt AND refuse
  to execute.
- `parent: Agent` carries cwd + lineage — Executor passes the current session's agent.
- `outputSchema` gives the child's structured output for §14 evidence collection.
- `signal` gives cancellation propagation (§15, §18 unload ordering).
- `stopReason` distinguishes completed vs max-tokens vs refusal → Verifier can treat
  non-completed as non-passing.

## 2. `ctx.storageDomain` — CONFIRMED, mounted

Package group `packages/storage`:
- `@deepseek-ai/dsh-storage` — connects backends, `ctx.storage`. Mounted as `storage`.
- `@deepseek-ai/dsh-storage-json` — JSON file backend. Mounted, root `dshHomePath('storages')`.
- `@deepseek-ai/dsh-storage-sqlite` — SQLite backend (not mounted by default).
- `@deepseek-ai/dsh-storage-domain` — schema-validated KV domains, `ctx.storageDomain`. Mounted.

### Usage

```ts
const spec = defineDomain({ name: 'grasp', version: 1,
  tables: { skills: domainTable(compiledSkillSchema), plans: domainTable(planSchema) } })
const domain = await ctx.storageDomain.open(spec)
domain.table('skills').put(id, record)          // durable before resolve
const r = domain.table('skills').get(id)        // synchronous, from memory
domain.table('skills').update(id, f)            // atomic update
domain.close()                                  // caller-owned handle; facility closes on unmount
```

- Reads are synchronous from authoritative in-memory state; every write resolves only after
  the backend acknowledges durability; each write emits `domain/changed`.
- Errors: `already-open`, `facet-unsupported`, `invalid-record`, `missing-key`, `closed`.
- Host-side only: registers no tools, injects no prompts, writes no session events.

### Relevance

- Satisfies §16 persistence (Skill Library, plans, node states, idempotency keys, evidence,
  repair patches) with schema validation + durability + change events.
- `domain.close()` in plugin `ctx.effect` → §18 unload ordering (persist, then close).

## 3. `ctx.skills` — CONFIRMED (already used)

- `ctx.skills.list({scope, cwd})` / `ctx.skills.get(name, {scope, cwd})` already used by
  `dshSkillsSource`. `get()` returns a record with `content` (the SKILL.md body), `description`,
  `whenToUse` — enough to build `CompiledSkill.source.contentHash`.

## 4. Execution-spec delta check

| Spec requirement | Status |
|---|---|
| §13 AgentSkillExecutor via `ctx.subagents.start` (spawn) | Interfaces ready, provider mounted |
| §13 capability limits via `toolFilter` | Ready (tools.restrict semantics) |
| §14 evidence via `outputSchema` + tool records | Structured value ready; file/command evidence needs Executor collection |
| §16 persistence via `ctx.storageDomain` | Ready (JSON backend mounted) |
| §18 `ctx.graspRuntime` deps: tools/skills/subagents/storageDomain | All mounted in web profile |
| Plugin peerDependencies | Must declare `@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-storage-domain` (or access via `ctx.get`) |

## 5. Open items before implementation

1. Verify `skills.get()` field names empirically (name/description/content/whenToUse).
2. Decide first AgentSkillExecutor backend: `spawn` (fresh child, empty conversation — task
   prompt must be self-contained) vs `fork` (child seeded with parent history). Spec's
   "load skill content + inject node params/expected effects/upstream artifacts" favors
   `spawn` with a fully composed prompt.
3. Storage domain schema: `compiledSkill` and `executionPlan` zod records with
   `schemaVersion` + content-hash cache keys (§9.1).
