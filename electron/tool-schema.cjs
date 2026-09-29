// The same schema is passed to Codex exec and App Server. It constrains the
// generated response, rather than relying on examples inside a text prompt.
const string = { type: 'string' }
const number = { type: 'number' }
const boolean = { type: 'boolean' }
const strings = { type: 'array', items: string }
const optional = schema => ({ anyOf: [schema, { type: 'null' }] })
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const toolArguments = {
  spawn_agent: { task: string, reason: string, name: optional(string), providerId: optional(string), model: optional(string), reasoningEffort: optional({ type: 'string', enum: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'enabled'] }), memoryProfile: optional({ type: 'string', enum: ['project', 'project-global'] }), continueFrom: optional(string) },
  context_read: { key: optional(string) },
  context_save: { key: string, summary: string, files: optional(strings) },
  model_evaluate: { agentId: string, taskType: string, assessment: string, evidence: string },
  improvement_plan: { status: { type: 'string', enum: ['planning', 'implementing', 'completed', 'blocked'] }, tasks: { type: 'array', items: object({ id: string, title: string, status: { type: 'string', enum: ['pending', 'working', 'done', 'blocked'] }, evidence: string }) } },
  wait_agent: { agentId: optional(string), timeout_ms: optional(number) },
  send_message: { agentId: string, message: string, replyTo: optional(string) },
  broadcast_message: { message: string, agentIds: optional(strings), replyTo: optional(string) },
  ask_team: { message: string, topic: optional(string), files: optional(strings), agentIds: optional(strings), replyTo: optional(string) },
  index_search: { query: string, limit: optional(number) },
  index_outline: { path: string },
  team_history: { agent: optional(string), runId: optional(string), limit: optional(number) },
  read_conversation: { afterId: optional(string), limit: optional(number) },
  read_messages: { unread_only: optional(boolean) },
  wait_message: { timeout_ms: optional(number) },
  followup_agent: { agentId: string, task: string, reason: optional(string) },
  list_agents: {},
  read_file: { path: string, start_line: optional(number), limit: optional(number) },
  list_files: { path: optional(string), recursive: optional(boolean), limit: optional(number) },
  write_file: { path: string, content: string },
  edit_file: { path: string, old_text: string, new_text: string },
  run_command: { command: string, args: optional(strings), cwd: optional(string), timeout_ms: optional(number) },
  memory_search: { query: optional(string), limit: optional(number) },
  memory_save: { title: string, content: string, scope: optional({ type: 'string', enum: ['chat', 'project', 'global'] }), type: optional(string), id: optional(string), confidence: optional(number) },
  memory_forget: { id: string },
  capability_list: {},
  capability_search: { query: string, limit: optional(number) },
  capability_read: { id: string },
  capability_feedback: { id: string, outcome: { type: 'string', enum: ['worked', 'partial', 'failed'] }, note: optional(string) },
  capability_install: { name: string, instructions: string, description: string, whenToUse: optional(string), id: optional(string), scope: optional({ type: 'string', enum: ['project', 'global'] }), source: optional(string) },
}
const ORBIT_RESPONSE_SCHEMA = object({
  content: string,
  tool_calls: {
    type: 'array',
    items: { anyOf: Object.entries(toolArguments).map(([name, properties]) => object({
      id: string,
      name: { type: 'string', enum: [name] },
      arguments: object(properties),
    })) },
  },
})

// Only a complete, schema-valid assistant message can transfer control to Orbit.
// Never interpret JSON embedded in prose, reasoning, or native tool output.
function matchesSchema(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(option => matchesSchema(value, option))
  if (schema.enum && !schema.enum.includes(value)) return false
  if (schema.type === 'null') return value === null
  if (schema.type === 'array') return Array.isArray(value)
    && (schema.maxItems === undefined || value.length <= schema.maxItems)
    && value.every(item => matchesSchema(item, schema.items))
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
    // Commentary is not constrained by Codex's final-output schema. Omitted
    // nullable arguments have the same runtime meaning as explicit null.
    && (schema.required || []).every(key => Object.hasOwn(value, key) || schema.properties[key]?.anyOf?.some(option => option.type === 'null'))
    && Object.keys(value).every(key => Object.hasOwn(schema.properties, key)
      ? matchesSchema(value[key], schema.properties[key]) : schema.additionalProperties !== false)
  return typeof value === schema.type
}

function isOrbitToolEnvelope(text, schema) {
  if (!schema || typeof text !== 'string') return false
  try {
    const value = JSON.parse(text)
    return Array.isArray(value?.tool_calls) && value.tool_calls.length > 0 && matchesSchema(value, schema)
  } catch { return false }
}

function isOrbitResponseEnvelope(text, schema) {
  if (!schema || typeof text !== 'string') return false
  try { return matchesSchema(JSON.parse(text), schema) } catch { return false }
}

const TOOL_HANDOFF = Symbol('Orbit tool handoff')
module.exports = { ORBIT_RESPONSE_SCHEMA, isOrbitToolEnvelope, isOrbitResponseEnvelope, TOOL_HANDOFF }
