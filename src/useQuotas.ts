import { useEffect, useRef, useState } from 'react'
import type { ProviderOption, QuotaSnapshot } from './types'
import { errorText } from './format'

// Quota readings of every subscription, shared by the composer chip, the sidebar dot and the quota panel. The desktop
// pushes the updates it makes on its own (onQuotaUpdate); the renderer asks again after a run ends and while the panel
// is open. `providerOptions` is a ref so the scheduled refresh always sends the current CLI settings.
export function useQuotas(providerOptions: { current: Record<string, ProviderOption> | undefined }, onError: (text: string) => void) {
  const [quotas, setQuotas] = useState<Record<string, QuotaSnapshot>>({})
  const [quotaBusy, setQuotaBusy] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  async function refreshQuotas(force = false) {
    const api = window.orbit
    if (!api) return
    setQuotaBusy(true)
    try { setQuotas(await api.getQuotas(providerOptions.current, force)) }
    catch (error) { onError(`Не удалось получить квоты: ${errorText(error)}`) }
    finally { setQuotaBusy(false) }
  }
  useEffect(() => {
    const api = window.orbit
    if (!api) return
    const off = api.onQuotaUpdate(update => { if (update.snapshot) setQuotas(previous => ({ ...previous, [update.providerId]: update.snapshot! })) })
    void refreshQuotas()
    return () => { off(); window.clearTimeout(timer.current) }
  }, [])
  // A run has just spent quota: read it again once the burst of finishing runs has settled.
  function scheduleQuotaRefresh() {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void refreshQuotas(true), 2500)
  }
  return { quotas, quotaBusy, refreshQuotas, scheduleQuotaRefresh }
}

// The open quota window keeps itself current; the shared cache makes this cheap.
export function useQuotaPolling(active: boolean, refreshQuotas: () => Promise<void>) {
  useEffect(() => {
    if (!active) return
    void refreshQuotas()
    const timer = window.setInterval(() => void refreshQuotas(), 60000)
    return () => window.clearInterval(timer)
  }, [active])
}
