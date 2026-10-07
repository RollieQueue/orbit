// The provider catalogue the renderer shows: composer select, provider cards, quota panel. Ids match electron/providers.cjs.
export type ProviderInfo = { id: string; name: string; description: string; help: string; base?: string }

export const providers: ProviderInfo[] = [
  { id: 'codex', name: 'Codex', description: 'CLI · подписка или API', help: 'Установите Codex CLI и выполните codex login в терминале.' },
  { id: 'claude', name: 'Claude Code', description: 'CLI · подписка или API', help: 'Установите Claude Code и войдите в аккаунт командой claude.' },
  {
    id: 'antigravity', name: 'Antigravity', description: 'CLI · Google AI Pro / Ultra',
    help: 'Установите Antigravity CLI и войдите в Google-аккаунт через agy. Доступ зависит от подписки и поддерживаемого Google региона аккаунта.',
  },
  {
    id: 'cursor', name: 'Cursor', description: 'CLI · подписка Cursor',
    help: 'Cursor IDE и Cursor CLI устанавливаются отдельно. Для Orbit установите Cursor CLI и выполните agent login. Модели загружаются из CLI.',
  },
  {
    id: 'ollama', name: 'Ollama', description: 'Локальные модели',
    help: 'Запустите Ollama. Модель можно указать в настройках; адрес сервера задаётся через ORBIT_OLLAMA_URL.',
  },
  {
    id: 'custom', name: 'OpenAI-compatible', description: 'Совместимый API',
    help: 'Задайте ORBIT_OPENAI_BASE_URL, ORBIT_OPENAI_API_KEY и ORBIT_OPENAI_MODEL в окружении приложения.',
  },
]

// The extra subscriptions of the settings in use (src/subscriptions.ts providerList), so that a name asked for by id also finds
// "claude-2" without every caller passing the list around; a deleted subscription is unknown here and prints as its id.
let extraProviders: ProviderInfo[] = []
export const registerExtraProviders = (list: ProviderInfo[]) => { extraProviders = list }
export const providerName = (id?: string | null) => providers.find(provider => provider.id === id)?.name ?? extraProviders.find(provider => provider.id === id)?.name
