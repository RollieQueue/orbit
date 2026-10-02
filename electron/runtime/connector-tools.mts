// connector_add / connector_list / connector_remove / connector_test: external MCP servers (connectors.mts) that Orbit
// passes to the provider processes of runs with full access. Nothing here returns a secret: env and header values are
// stored and handed to the server, the agent only ever sees their names.
import { testConnector } from '../connectors.mts'
import type { ConnectorScope } from '../connectors.mts'
import type { AgentRecord, OrbitRuntimeLike, RunRecord, ToolArgs } from '../types.mts'
import { agentConnectors } from './util.mts'

const APPLIES_LATER = 'Applies to provider processes launched afterwards: your own next turn when your provider starts a process per turn (Claude, Cursor, Antigravity), and a helper you start next with spawn_agent {connectors:["name"]} (a Codex session keeps the process it has, so use a new helper there).'

async function executeConnectorTool(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, name: string, args: ToolArgs, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const store = runtime.connectorStore
  if (!store) throw new Error('Connectors are unavailable in this runtime')
  const fullAccess = run.accessMode === 'danger-full-access'
  if (name === 'connector_list') {
    const connectors = store.list(run.workspace)
    // What this agent's own provider process gets now: the root every enabled connector, a helper those its spawn named that are still enabled.
    const passedToThisAgent = agentConnectors(runtime, run, agent).map(item => item.name)
    const note = !fullAccess
      ? `This run has ${run.accessMode} access: connectors reach only provider processes of runs with full access, so none of these is available here.`
      : !agent.parentId
        ? `Enabled connectors are passed to your own provider process; a helper gets one only when you name it in spawn_agent {connectors:[names]} (each helper starts its own copy of the server, so pass it only to a helper that needs its tools). ${connectors.length ? 'connector_test checks one.' : 'None is registered: connector_add registers one.'}`
        : passedToThisAgent.length
          ? `Your parent passed you ${passedToThisAgent.join(', ')} at spawn: those tools are native tools of yours. Helpers you spawn get one only when you name it in spawn_agent {connectors:[names]}, and only one of these.`
          : `You have no connector: a helper gets one only when its parent passed it with spawn_agent {connectors:[names]}${agent.connectors?.length ? ` (yours, ${agent.connectors.join(', ')}, is no longer enabled)` : ' and this spawn named none'}. Ask your parent if you need one.`
    return { connectors, passedToThisRun: fullAccess, passedToThisAgent, note }
  }
  // A stdio server runs any command outside every sandbox; the registry hides these tools below full access, this refuses a call that comes anyway (the JSON envelope).
  if (!fullAccess) throw new Error(`${name} needs full access: a connector's server runs outside every sandbox (this run has ${run.accessMode} access)`)
  const scope = args.scope === 'global' ? 'global' : args.scope === undefined || args.scope === 'project' ? 'project' : null
  if (!scope) throw new Error('scope must be "project" or "global"')
  if (name === 'connector_add') {
    const { connector, replaced } = store.add({ name: args.name, description: args.description, command: args.command, args: args.args, env: args.env, url: args.url, headers: args.headers, enabled: args.enabled }, { scope: scope as ConnectorScope, workspace: run.workspace })
    const state = connector.enabled ? APPLIES_LATER : 'It is switched off: no process is launched with it until connector_add gives it again with enabled true.'
    return { ok: true, ...connector, replaced, note: `${replaced ? 'Replaced' : 'Registered'}. ${state} Run connector_test {name:"${connector.name}"} to check that it starts and which tools it offers; in Claude Code its tools are named mcp__${connector.name}__<tool>.` }
  }
  if (name === 'connector_remove') {
    const gone = store.remove(String(args.name), { scope: args.scope === undefined ? undefined : scope as ConnectorScope, workspace: run.workspace })
    if (!gone) throw new Error(`No connector named "${String(args.name).slice(0, 60)}"${args.scope ? ` in the ${args.scope} scope` : ''}; connector_list shows what is registered`)
    return { ok: true, removed: gone.name, scope: gone.scope, note: 'Processes launched afterwards no longer get it; one already running keeps it until it ends.' }
  }
  if (name === 'connector_test') {
    const found = store.find(String(args.name), run.workspace, args.scope === undefined ? undefined : scope as ConnectorScope)
    if (!found) throw new Error(`No connector named "${String(args.name).slice(0, 60)}"; connector_list shows what is registered`)
    const result = await testConnector(found, { cwd: run.workspace, signal })
    return {
      ...result, scope: found.scope, enabled: found.enabled,
      ...(result.ok ? { note: `${result.tools?.length ?? 0} tools. In Claude Code they are named mcp__${found.name}__<tool>. ${found.enabled ? '' : 'The connector is disabled, so processes are not launched with it. '}${APPLIES_LATER}` } : { hint: 'Fix the command, args, env or url (connector_add again with the same name replaces it) and test again.' }),
    }
  }
  throw new Error(`Unknown tool: ${name}`)
}

export { executeConnectorTool }
