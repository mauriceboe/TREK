import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import rtlTextPluginUrl from '@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url'
import { registerRtlTextPlugin } from '../rtlText'

/**
 * The only module in the client that pulls mapbox-gl in at runtime.
 *
 * It has to stay reachable through `import('./engines/mapbox')` and nothing else:
 * a static import from anywhere in the tree drags 1.8 MB into the parent chunk and
 * quietly undoes the split. `npm run check:gl-split` fails on that.
 */
// Arabic/Hebrew/Persian labels come out unjoined and reversed without this.
// Mapbox's signature is (url, callback, deferred) — see rtlText.ts.
registerRtlTextPlugin(() => mapboxgl.setRTLTextPlugin(rtlTextPluginUrl, null, true))

export default mapboxgl
