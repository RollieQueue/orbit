import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// A render error would otherwise leave a blank window with no way back, while agents keep running in the
// main process. This keeps the window usable and offers a reload that restores everything from saved state.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Orbit renderer error', error, info.componentStack) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" style={{ padding: 32, maxWidth: 640, margin: '10vh auto', lineHeight: 1.6 }}>
        <h2>Интерфейс Orbit столкнулся с ошибкой</h2>
        <p>Агенты продолжают работать, данные сохранены. Перезагрузите интерфейс, чтобы продолжить.</p>
        <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{this.state.error.message}</pre>
        <button type="button" onClick={() => location.reload()}>Перезагрузить интерфейс</button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
