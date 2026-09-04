import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import rtlTextPluginUrl from '@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url'
import { registerRtlTextPlugin } from '../rtlText'

/**
 * The only module in the client that pulls maplibre-gl in at runtime. Same rule as
 * its mapbox sibling: reachable through a dynamic import and no other way.
 *
 * The two engines share their API surface for everything TREK uses — Map, Marker,
 * Popup, LngLatBounds — which is why the components take the engine as a prop and
 * stay engine-agnostic. Where the two genuinely differ, the caller already guards
 * on the provider (projection, accessToken, aroundCenter).
 */
// Arabic/Hebrew/Persian labels come out unjoined and reversed without this.
// MapLibre's signature is (url, lazy) and it resolves a promise — see rtlText.ts.
registerRtlTextPlugin(() => maplibregl.setRTLTextPlugin(rtlTextPluginUrl, true))

export default maplibregl
