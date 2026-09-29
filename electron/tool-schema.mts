// @ts-nocheck
// The JSON envelope schema for envelope-transport providers (Codex exec --output-schema, App Server outputSchema,
// Antigravity --json-schema and the parsers' handoff check). It is derived from the tool registry, the single source
// of truth for every Orbit tool, in the order the schema always had so its bytes do not change.
import { TOOLS } from './tool-registry.mts'
const string = { type: 'string' }
const optional = schema => ({ anyOf: [schema, { type: 'null' }] })
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const ENVELOPE_ORDER = ['spawn_agent', 'context_read', 'context_save', 'model_evaluate', 'improvement_plan', 'wait_agent', 'send_message', 'broadcast_message', 'ask_team', 'index_search', 'index_outline', 'team_history', 'read_conversation', 'read_messages', 'wait_message', 'followup_agent', 'list_agents', 'read_file', 'list_files', 'write_file', 'edit_file', 'run_command', 'memory_search', 'memory_save', 'memory_forget', 'capability_list', 'capability_search', 'capability_read', 'capability_feedback', 'capability_install']
const ordered = [...ENVELOPE_ORDER.map(name => TOOLS.find(tool => tool.name === name)), ...TOOLS.filter(tool => !tool.internal && !ENVELOPE_ORDER.includes(tool.name))].filter(Boolean)
// The envelope requires every key and lets unused optional ones be null (or omitted, see matchesSchema).
const toolArguments = Object.fromEntries(ordered.map(tool => [tool.name, Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key, schema]) => [key, tool.inputSchema.required.includes(key) ? schema : optional(schema)]))]))
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
export { ORBIT_RESPONSE_SCHEMA, isOrbitToolEnvelope, isOrbitResponseEnvelope, matchesSchema, TOOL_HANDOFF, toolArguments }
