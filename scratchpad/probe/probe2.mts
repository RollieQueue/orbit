type Base = { a: string }
type Ext = Base & { b?: number }
interface I { c: string }
type ViaInterface = I & { d?: number }
declare const ext: Ext
declare const vi: ViaInterface
const x: { [k: string]: unknown } = ext
const y: { [k: string]: unknown } = vi
type Src = { command?: string; transport?: string; [extra: string]: unknown }
type Dst = { command?: string; proxyMode?: string }
declare const src: Src
const z: Dst = src
