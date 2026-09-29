const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('orbit', {
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  inspectWorkspace: (workspace) => ipcRenderer.invoke('workspace:inspect', workspace),
  cloneWorkspace: (remote) => ipcRenderer.invoke('workspace:clone', remote),
  startTask: (payload) => ipcRenderer.invoke('runtime:start', payload),
  routeMessage: (payload) => ipcRenderer.invoke('runtime:route-message', payload),
  stopTask: (runId) => ipcRenderer.invoke('runtime:stop', runId),
  listRuns: () => ipcRenderer.invoke('runtime:list'),
  getRun: (runId) => ipcRenderer.invoke('runtime:get', runId),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  spawnSubAgent: (payload) => ipcRenderer.invoke('runtime:spawn-subagent', payload),
  getProjectContext: (workspace) => ipcRenderer.invoke('project-context:get', workspace),
  projectIndexStatus: (workspace, rebuild) => ipcRenderer.invoke('project-index:status', workspace, rebuild === true),
  listMemory: (workspace) => ipcRenderer.invoke('memory:list', workspace),
  searchMemory: (query, workspace) => ipcRenderer.invoke('memory:search', query, workspace),
  saveMemory: (entry) => ipcRenderer.invoke('memory:save', entry),
  removeMemory: (id, workspace) => ipcRenderer.invoke('memory:remove', id, workspace),
  listCapabilities: (workspace) => ipcRenderer.invoke('capabilities:list', workspace),
  readCapability: (id, workspace) => ipcRenderer.invoke('capabilities:read', id, workspace),
  installCapability: (entry) => ipcRenderer.invoke('capabilities:install', entry),
  removeCapability: (id, workspace) => ipcRenderer.invoke('capabilities:remove', id, workspace),
  restoreCapability: (id, version, workspace) => ipcRenderer.invoke('capabilities:restore', id, version, workspace),
  checkProviders: (options) => ipcRenderer.invoke('providers:health', options),
  applyArtifact: (payload) => ipcRenderer.invoke('artifact:apply', payload),
  onRuntimeEvent: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('runtime:event', listener)
    return () => ipcRenderer.removeListener('runtime:event', listener)
  },
  openExternal: (target) => ipcRenderer.invoke('shell:open', target),
  platform: process.platform,
})
