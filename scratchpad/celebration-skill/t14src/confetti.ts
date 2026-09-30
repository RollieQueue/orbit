// The confetti of the celebration (CelebrationOverlay.tsx): paper pieces that flutter and spin, mixed with emoji pieces, a big burst
// at the start and a steady rain afterwards, drawn on a full-screen canvas. Returns a stop function that ends the animation.

const COLORS = ['#ff3b6b', '#ffb400', '#2ee6a6', '#39a0ff', '#b45cff', '#ff7a2f', '#f5ff3d', '#ffffff']
const EMOJI = ['🎉', '🥳', '🦆', '🍕', '🌈', '⭐', '💾', '🚀', '🎊', '🐸', '🍩', '🦄', '💃', '🔥', '👾']
const MAX_PIECES = 420
const BURST_PIECES = 180
const RAIN_PER_SECOND = 70
const GRAVITY = 0.00042
const DRAG = 0.0012

type Piece = {
  x: number; y: number; vx: number; vy: number; size: number; angle: number; spin: number
  phase: number; flutter: number; color: string; emoji?: string; shape: 'rect' | 'strip' | 'circle'
}

const between = (low: number, high: number) => low + Math.random() * (high - low)
const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)]

function makePiece(x: number, y: number, vx: number, vy: number, scale: number): Piece {
  const emoji = Math.random() < 0.28 ? pick(EMOJI) : undefined
  return {
    x, y, vx, vy, angle: between(0, Math.PI * 2), spin: between(-0.012, 0.012), phase: between(0, Math.PI * 2), flutter: between(0.004, 0.009),
    size: (emoji ? between(22, 40) : between(8, 16)) * scale, color: pick(COLORS), emoji, shape: pick(['rect', 'rect', 'strip', 'circle'] as const),
  }
}

// Two cannons in the bottom corners and one in the middle shoot the first pieces up and inwards.
function burst(width: number, height: number, scale: number): Piece[] {
  const cannons = [{ x: 0, dir: 1 }, { x: width, dir: -1 }, { x: width / 2, dir: 0 }]
  return Array.from({ length: BURST_PIECES }, (_, index) => {
    const cannon = cannons[index % cannons.length]
    const speed = between(0.6, 1.5) * Math.min(1, Math.max(0.6, height / 800))
    const angle = cannon.dir === 0 ? between(-0.6, 0.6) : between(0.25, 0.95) * cannon.dir
    return makePiece(cannon.x, height, Math.sin(angle) * speed, -Math.cos(angle) * speed, scale)
  })
}

function draw(context: CanvasRenderingContext2D, piece: Piece) {
  context.save()
  context.translate(piece.x, piece.y)
  context.rotate(piece.angle)
  if (piece.emoji) {
    context.font = `${piece.size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(piece.emoji, 0, 0)
  } else {
    // A piece of paper turns around its own edge: its height follows the cosine of the flip phase.
    context.scale(1, Math.cos(piece.phase))
    context.fillStyle = piece.color
    if (piece.shape === 'circle') { context.beginPath(); context.arc(0, 0, piece.size / 2, 0, Math.PI * 2); context.fill() }
    else if (piece.shape === 'strip') context.fillRect(-piece.size / 2, -piece.size / 6, piece.size, piece.size / 3)
    else context.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size * 0.7)
  }
  context.restore()
}

export function startConfetti(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext('2d')
  if (!context) return () => undefined
  let width = 0
  let height = 0
  let ratio = 1
  const resize = () => {
    ratio = window.devicePixelRatio || 1
    width = window.innerWidth
    height = window.innerHeight
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
  }
  resize()
  window.addEventListener('resize', resize)
  const scale = () => Math.min(1.6, Math.max(0.8, width / 1200))
  let pieces = burst(width, height, scale())
  let last = performance.now()
  let rain = 0
  let frame = 0
  const tick = (time: number) => {
    // A long pause (a hidden tab) must not throw the pieces across the screen.
    const dt = Math.min(48, time - last)
    last = time
    rain += (RAIN_PER_SECOND * dt) / 1000
    while (rain >= 1) {
      rain -= 1
      if (pieces.length < MAX_PIECES) pieces.push(makePiece(between(0, width), -40, between(-0.08, 0.08), between(0.02, 0.12), scale()))
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    for (const piece of pieces) {
      piece.vy += GRAVITY * dt
      // Air resistance caps the fall speed, the sway makes the paper flutter from side to side.
      piece.vx -= piece.vx * DRAG * dt
      piece.vy -= Math.max(0, piece.vy - 0.16) * DRAG * 6 * dt
      piece.phase += piece.flutter * dt * 2.4
      piece.x += (piece.vx + Math.sin(piece.phase) * 0.05) * dt
      piece.y += piece.vy * dt
      piece.angle += piece.spin * dt
      draw(context, piece)
    }
    pieces = pieces.filter(piece => piece.y < height + 60 && piece.x > -80 && piece.x < width + 80)
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize) }
}
