// T14 visual check: the real Celebration component with the default action, as the app would show it.
import { createRoot } from 'react-dom/client'
import { Celebration } from '../../../src/CelebrationOverlay'
import '../../../src/styles.css'

const action = { on: 'task-completed', effect: 'celebration', video: 'https://www.youtube.com/watch?v=6-8E4Nirh9s', videoId: '6-8E4Nirh9s', start: 42, end: 73 } as const
const log = (text: string) => { (window as unknown as { __closed?: string[] }).__closed = [...((window as unknown as { __closed?: string[] }).__closed || []), text] }
createRoot(document.getElementById('root')!).render(<Celebration action={action} onClose={() => log(`closed at ${Math.round(performance.now())} ms`)} />)
