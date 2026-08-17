'use client'

// A real slippy map with the live traffic on it, in a window you can drag.
//
// Leaflet over a dark CARTO basemap, with our own ADS-B targets drawn on top.
// Not an embed of FlightRadar24: they have no free API, they block framing, and
// scraping them is against their terms. This shows the same picture from the same
// kind of data, sourced the way the rest of the app sources it.
//
// The tiles need the network. In replay mode there may not be one, so the map
// keeps a dark background and the targets still plot: the basemap is context,
// not the content.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap, LayerGroup } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Aircraft } from '@/lib/types'
import { SFO } from '@/lib/adsb'
import { altitudeTag, formatVerticalRate } from '@/lib/format'

type Props = {
  traffic: Aircraft[]
  /** Aircraft with a strip in the bay, drawn brighter and always labelled. */
  watched: Set<string>
  onClose: () => void
  onPick?: (a: Aircraft) => void
}

const SIZES = { compact: { w: 380, h: 340 }, large: { w: 640, h: 520 } } as const

export function MapPanel({ traffic, watched, onClose, onPick }: Props) {
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState<keyof typeof SIZES>('compact')
  const [dragging, setDragging] = useState(false)
  const [tilesFailed, setTilesFailed] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement>(null)
  const mapDivRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const layerRef = useRef<LayerGroup | null>(null)
  // Kept in a ref so the marker effect does not need to re-run when the handler
  // identity changes on every parent render.
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  const { w, h } = SIZES[size]

  useEffect(() => {
    setPos({ x: Math.max(12, window.innerWidth - w - 32), y: 88 })
    // First mount only: after that the operator owns the position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Create the map once.
  useEffect(() => {
    let cancelled = false
    const el = mapDivRef.current
    if (!el) return

    import('leaflet').then((L) => {
      if (cancelled || mapRef.current) return
      const map = L.map(el, {
        center: [SFO.lat, SFO.lon],
        zoom: 9,
        zoomControl: true,
        attributionControl: true,
      })
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 19,
      })
        .on('tileerror', () => setTilesFailed(true))
        .addTo(map)

      // The 40 nm ring the rest of the app works inside, so the map and the
      // traffic list are visibly showing the same thing.
      L.circle([SFO.lat, SFO.lon], {
        radius: SFO.radiusNm * 1852,
        color: '#333d48',
        weight: 1,
        fill: false,
      }).addTo(map)

      layerRef.current = L.layerGroup().addTo(map)
      mapRef.current = map
    })

    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  // Leaflet measures its container once, so it has to be told when the window
  // changes size or it renders into the old box.
  useEffect(() => {
    const id = window.setTimeout(() => mapRef.current?.invalidateSize(), 60)
    return () => window.clearTimeout(id)
  }, [size])

  // Redraw the targets on every snapshot.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    let cancelled = false

    import('leaflet').then((L) => {
      if (cancelled) return
      layer.clearLayers()

      for (const a of traffic) {
        if (a.onGround) continue
        const isWatched = watched.has(a.hex)
        const stale = a.seenPosSec > 15
        const colour = stale ? '#55606b' : isWatched ? '#d99a22' : '#8b98a5'
        const track = a.trackTrue ?? 0

        // A chevron pointing along the ground track, which is how you read
        // where an aircraft is going without waiting for it to move.
        const label = isWatched
          ? `<div style="margin-left:11px;white-space:nowrap;font:500 10px/1.25 ui-monospace,monospace;color:${colour}">
               ${a.callsign ?? a.hex}<br/>${a.altFt != null ? altitudeTag(a.altFt) : '---'} ${
                 a.vsFpm != null && Math.abs(a.vsFpm) > 300 ? (a.vsFpm > 0 ? '&#9650;' : '&#9660;') : ''
               } ${a.gsKt != null ? Math.round(a.gsKt) : '---'}
             </div>`
          : ''

        const icon = L.divIcon({
          className: '',
          iconSize: [0, 0],
          html: `<div style="position:relative">
                   <div style="position:absolute;left:-5px;top:-5px;width:10px;height:10px;
                               transform:rotate(${track}deg);
                               border-left:5px solid transparent;border-right:5px solid transparent;
                               border-bottom:10px solid ${colour};
                               opacity:${stale ? 0.5 : 1}"></div>
                   <div style="position:absolute;top:-6px">${label}</div>
                 </div>`,
        })

        const marker = L.marker([a.lat, a.lon], { icon, keyboard: false })
        marker.bindTooltip(
          `${a.callsign ?? a.hex} ${a.registration ?? ''} ${a.type ?? ''}<br/>${
            a.altFt != null ? a.altFt.toLocaleString('en-US') + ' ft' : 'no altitude'
          } ${a.vsFpm != null ? formatVerticalRate(a.vsFpm) + ' fpm' : ''}`,
          { direction: 'top', opacity: 0.9 },
        )
        marker.on('click', () => onPickRef.current?.(a))
        marker.addTo(layer)
      }
    })

    return () => {
      cancelled = true
    }
  }, [traffic, watched])

  const clamp = useCallback((x: number, y: number) => {
    const el = panelRef.current
    const width = el?.offsetWidth ?? w
    return {
      x: Math.min(Math.max(8 - width + 90, x), window.innerWidth - 90),
      y: Math.min(Math.max(0, y), window.innerHeight - 40),
    }
  }, [w])

  const onPointerDown = (e: React.PointerEvent) => {
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
    setDragging(true)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return
    setPos(clamp(e.clientX - dragOffset.current.x, e.clientY - dragOffset.current.y))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(false)
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p.x, p.y))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const airborne = traffic.filter((a) => !a.onGround).length

  return (
    <div
      ref={panelRef}
      className="fixed z-50 border border-rule-bright bg-bay shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
      style={{ left: pos.x, top: pos.y, width: w }}
      role="dialog"
      aria-label="Traffic map"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`flex items-center justify-between border-b border-rule bg-bay-raised px-3 py-2 select-none ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <span className="label text-ink-dim">Map · KSFO {SFO.radiusNm} nm</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSize((s) => (s === 'compact' ? 'large' : 'compact'))}
            className="font-mono text-[11px] text-ink-faint hover:text-ink"
            aria-label={size === 'compact' ? 'Enlarge map' : 'Shrink map'}
          >
            {size === 'compact' ? '[ + ]' : '[ - ]'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] text-ink-faint hover:text-ink"
            aria-label="Close map"
          >
            [ x ]
          </button>
        </span>
      </div>

      <div ref={mapDivRef} style={{ width: w, height: h }} className="bg-bay-sunk" />

      <div className="flex items-center justify-between border-t border-rule px-3 py-2 font-mono text-[10px] text-ink-faint">
        <span>{airborne} airborne · click a target to address it</span>
        {tilesFailed && <span className="text-signal-stale">no tiles, targets only</span>}
      </div>
    </div>
  )
}
