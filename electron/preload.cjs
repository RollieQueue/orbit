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
  getRunChanges: (runId) => ipcRenderer.invoke('runtime:changes', runId),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  spawnSubAgent: (payload) => ipcRenderer.invoke('runtime:spawn-subagent', payload),
  getProjectContext: (workspace) => ipcRenderer.invoke('project-context:get', workspace),
  projectIndexStatus: (workspace, rebuild) => ipcRenderer.invoke('project-index:status', workspace, rebuild === true),
  listMemory: (workspace, chatId) => ipcRenderer.invoke('memory:list', workspace, chatId),
  searchMemory: (query, workspace, chatId) => ipcRenderer.invoke('memory:search', query, workspace, chatId),
  saveMemory: (entry) => ipcRenderer.invoke('memory:save', entry),
  removeMemory: (id, workspace, chatId) => ipcRenderer.invoke('memory:remove', id, workspace, chatId),
  pinMemory: (id, pinned, workspace, chatId) => ipcRenderer.invoke('memory:pin', id, pinned, workspace, chatId),
  setMemorySharing: (workspace, enabled) => ipcRenderer.invoke('memory:sharing', workspace, enabled),
  forgetChatMemory: (workspace, chatId) => ipcRenderer.invoke('memory:forget-chat', workspace, chatId),
  memoryStats: (workspace, chatId) => ipcRenderer.invoke('memory:stats', workspace, chatId),
  listCapabilities: (workspace) => ipcRenderer.invoke('capabilities:list', workspace),
  pinCapability: (id, pinned, workspace) => ipcRenderer.invoke('capabilities:pin', id, pinned, workspace),
  readCapability: (id, workspace) => ipcRenderer.invoke('capabilities:read', id, workspace),
  installCapability: (entry) => ipcRenderer.invoke('capabilities:install', entry),
  removeCapability: (id, workspace) => ipcRenderer.invoke('capabilities:remove', id, workspace),
  restoreCapability: (id, version, workspace) => ipcRenderer.invoke('capabilities:restore', id, version, workspace),
  checkProviders: (options) => ipcRenderer.invoke('providers:health', options),
  getQuotas: (options, force) => ipcRenderer.invoke('quota:get', options, force === true),
  onQuotaUpdate: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('quota:update', listener)
    return () => ipcRenderer.removeListener('quota:update', listener)
  },
  applyArtifact: (payload) => ipcRenderer.invoke('artifact:apply', payload),
  onRuntimeEvent: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('runtime:event', listener)
    return () => ipcRenderer.removeListener('runtime:event', listener)
  },
  openExternal: (target) => ipcRenderer.invoke('shell:open', target),
  platform: process.platform,
})
