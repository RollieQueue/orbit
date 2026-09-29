interface Loose { runId: string; agents?: { id: string; [f: string]: unknown }[]; [field: string]: unknown }
interface View { runId: string; prompt?: string; agents?: { id: string; name?: string }[] }
declare const loose: Loose
const v: View = loose
interface Snap { runId: string; status: 'a' | 'b'; nested: { x: number } }
declare const snap: Snap
const l: Loose = snap
type SnapT = { runId: string; status: 'a' | 'b'; nested: { x: number } }
declare const snapT: SnapT
const l2: Loose = snapT
const f = <V,>(cb: (v: V) => void, v: V) => cb(v)
f((x: number) => console.log(x), 1)
class C implements View { declare runId: string; constructor() { Object.assign(this, { runId: 'x' }) } }
console.log('ok', new C().runId)
