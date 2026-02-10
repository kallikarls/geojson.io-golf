const mapboxgl = require('maplibre-gl');

require('qs-hash');
const geojsonRewind = require('@mapbox/geojson-rewind');
const MapboxDraw = require('@mapbox/mapbox-gl-draw').default;
const MapboxGeocoder = require('@mapbox/mapbox-gl-geocoder');

const DrawLineString = require('../draw/linestring');
const DrawRectangle = require('../draw/rectangle');
const DrawCircle = require('../draw/circle');
const SimpleSelect = require('../draw/simple_select');
const ExtendDrawBar = require('../draw/extend_draw_bar');
const DrawGreen = require('../draw/green');
const { EditControl, SaveCancelControl, TrashControl } = require('./controls');
const { geojsonToLayer, bindPopup } = require('./util');
const styles = require('./styles');
const {
  DEFAULT_STYLE,
  DEFAULT_PROJECTION,
  DEFAULT_DARK_FEATURE_COLOR,
  DEFAULT_LIGHT_FEATURE_COLOR,
  DEFAULT_SATELLITE_FEATURE_COLOR
} = require('../../constants');
const drawStyles = require('../draw/styles');

let writable = false;
let drawing = false;
let editing = false;

let pendingProps = null;  // properties to apply to the next created feature(s)

const dummyGeojson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [0, 0]
      }
    }
  ]
};

module.exports = function (context, readonly) {
  writable = !readonly;

  // keyboard shortcuts
  const keybinding = d3
    .keybinding('map')
    // delete key triggers draw.trash()
    .on('⌫', () => {
      if (editing) {
        context.Draw.trash();
      }
    })
    .on('m', () => {
      if (!editing) {
        context.Draw.changeMode('draw_point');
      }
    })
    .on('l', () => {
      if (!editing) {
        context.Draw.changeMode('draw_line_string');
      }
    })
    .on('p', () => {
      if (!editing) {
        context.Draw.changeMode('draw_polygon');
      }
    })
    .on('r', () => {
      if (!editing) {
        context.Draw.changeMode('draw_rectangle');
      }
    })
    .on('c', () => {
      if (!editing) {
        context.Draw.changeMode('draw_circle');
      }
    });

  d3.select(document).call(keybinding);

  function maybeShowEditControl() {
    // if there are features, show the edit button
    if (context.data.hasFeatures()) {
      d3.select('.edit-control').style('display', 'block');
    }
  }

  function map() {
    mapboxgl.accessToken =
      'pk.eyJ1Ijoic3ZjLW9rdGEtbWFwYm94LXN0YWZmLWFjY2VzcyIsImEiOiJjbG5sMnExa3kxNTJtMmtsODJld24yNGJlIn0.RQ4CHchAYPJQZSiUJ0O3VQ';

    mapboxgl.setRTLTextPlugin(
      'https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js',
      null,
      true
    );

    const projection = context.storage.get('projection') || DEFAULT_PROJECTION;
    let activeStyle = context.storage.get('style') || DEFAULT_STYLE;

    // FORCE OSM if the current style is a Mapbox style, to bypass the token issues
    if (activeStyle !== 'OSM') {
      console.warn(`Redirecting map style from ${activeStyle} to OSM due to authentication issues.`);
      activeStyle = 'OSM';
      context.storage.set('style', 'OSM');
    }

    // Always clear token when using OSM to avoid side-effect errors (glyphs/analytics)
    if (activeStyle === 'OSM') {
      mapboxgl.accessToken = '';
    }

    const foundStyle = styles.find((d) => d.title === activeStyle);
    const { style, config } =
      foundStyle || styles.find((d) => d.title === 'OSM') || styles[0];

    context.map = new mapboxgl.Map({
      container: 'map',
      style,
      ...(config ? { config } : {}),
      center: [20, 0],
      zoom: 2,
      projection,
      hash: 'map'
    });

    // Detect if Mapbox fails to authorize (401)
    context.map.on('error', (e) => {
      const msg = (e.error?.message || e.error || '').toString();
      // Only trigger fallback if we somehow started with a Mapbox style and it failed
      if (msg.includes('Unauthorized') || msg.includes('401') || msg.includes('invalid Mapbox access token')) {
        if (context._fallingBack) return;
        context._fallingBack = true;

        console.warn('Mapbox error detected. Ensuring fallback to OSM.');
        mapboxgl.accessToken = '';

        const osmStyle = styles.find(s => s.title === 'OSM')?.style;
        if (osmStyle && context.map.getStyle()?.name !== 'osm') {
          setTimeout(() => {
            try {
              context.map.setStyle(osmStyle, { diff: false });
            } catch (err) {
              // If setStyle fails because the map is not ready, just reload with the new default
              if (err.message?.includes('not done loading')) {
                window.location.reload();
              }
            }
          }, 300);
        }
      }
    });

    if (writable) {

      // Large GPS toolbar control (sprinkler + pump)
      class BigIrrigationToolbar {
        onAdd(map) {
          this._map = map;
          const el = document.createElement('div');
          el.className = 'mapboxgl-ctrl irrigation-ctrl';
          el.style.pointerEvents = 'auto'; // Force container clickable

          el.innerHTML = `
            <button class="irrigation-btn gps-head" title="Add Sprinkler @ My Location" aria-label="Add Sprinkler @ My Location" style="pointer-events: auto; cursor: pointer;">
              <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                <path d="M12 3l3 3-3 3-3-3 3-3zm0 7a1 1 0 011 1v5.05a4.5 4.5 0 11-2 0V11a1 1 0 011-1z"/>
              </svg>
              <span>Sprinkler</span>
            </button>
            <button class="irrigation-btn gps-pump" title="Add Pump @ My Location" aria-label="Add Pump @ My Location" style="pointer-events: auto; cursor: pointer;">
              <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                <path d="M7 7h10v4h2a2 2 0 012 2v4h-2v-3h-2v3H7v-3H5v3H3v-4a2 2 0 012-2h2V7zM9 7V5h6v2H9z"/>
              </svg>
              <span>Pump</span>
            </button>
          `;
          el.querySelector('.gps-head').addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            addHeadAtGPS();
          });
          el.querySelector('.gps-pump').addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            addPumpAtGPS();
          });

          // Prevent map drag on button click/hold
          ['mousedown', 'touchstart', 'dblclick'].forEach(evt => {
            el.querySelectorAll('button').forEach(btn => {
              btn.addEventListener(evt, (e) => e.stopPropagation());
            });
          });

          this._container = el;
          return el;
        }
        onRemove() { this._container?.remove(); this._map = undefined; }
      }

      context.map.addControl(new BigIrrigationToolbar(), 'top-right'); // or 'bottom-right'

      if (mapboxgl.accessToken) {
        context.map.addControl(
          new MapboxGeocoder({
            accessToken: mapboxgl.accessToken,
            mapboxgl,
            marker: true
          })
        );
      }

      // Filter draw styles to remove text-field and text-font if we are in OSM mode (no token)
      // This prevents the "glyphs" error crash and symbol placement errors
      const sanitizedDrawStyles = drawStyles.filter(style => {
        if (!mapboxgl.accessToken && style.layout && (style.layout['text-field'] || style.layout['text-font'])) {
          return false; // Completely remove symbol layers
        }
        return true;
      });

      context.Draw = new MapboxDraw({
        displayControlsDefault: false,
        modes: {
          ...MapboxDraw.modes,
          simple_select: SimpleSelect,
          direct_select: MapboxDraw.modes.direct_select,
          draw_line_string: DrawLineString,
          draw_rectangle: DrawRectangle,
          draw_circle: DrawCircle,
          draw_green: DrawGreen
        },
        controls: {},
        styles: sanitizedDrawStyles
      });

      // ✅ make it visible to the outside world (same object)
      if (typeof window !== 'undefined') {
        window.context = context;
      }

      const drawControl = new ExtendDrawBar({
        draw: context.Draw,
        buttons: [
          {
            on: 'click',
            action: () => {
              drawing = true;
              context.Draw.changeMode('draw_point');
            },
            classes: ['mapbox-gl-draw_ctrl-draw-btn', 'mapbox-gl-draw_point'],
            title: 'Draw Point (m)'
          },
          {
            on: 'click',
            action: () => {
              drawing = true;
              context.Draw.changeMode('draw_line_string');
            },
            classes: ['mapbox-gl-draw_ctrl-draw-btn', 'mapbox-gl-draw_line'],
            title: 'Draw LineString (l)'
          },
          {
            on: 'click',
            action: () => {
              drawing = true;
              context.Draw.changeMode('draw_polygon');
            },
            classes: ['mapbox-gl-draw_ctrl-draw-btn', 'mapbox-gl-draw_polygon'],
            title: 'Draw Polygon (p)'
          },
          {
            on: 'click',
            action: () => {
              drawing = true;
              context.Draw.changeMode('draw_rectangle');
            },
            classes: [
              'mapbox-gl-draw_ctrl-draw-btn',
              'mapbox-gl-draw_rectangle'
            ],
            title: 'Draw Rectangular Polygon (r)'
          },
          {
            on: 'click',
            action: () => {
              drawing = true;
              context.Draw.changeMode('draw_circle');
            },
            classes: ['mapbox-gl-draw_ctrl-draw-btn', 'mapbox-gl-draw_circle'],
            title: 'Draw Circular Polygon (c)'
          },
          // {
          //   on: 'click',
          //   action: () => {
          //     drawing = true;
          //     context.Draw.changeMode('draw_green');
          //   },
          //   classes: ['mapbox-gl-draw_ctrl-draw-btn', 'mapbox-gl-draw_green'],
          //   title: 'Draw Green'
          // },
          // {
          //   on: 'click',
          //   action: () => {
          //     drawing = true;
          //     pendingProps = { layer: 'irrigation.main' };
          //     context.Draw.changeMode('draw_line_string')
          //   },
          //   classes: ['mapbox-gl-draw_ctrl-draw-btn','mapbox-gl-draw-irrigation-main'],
          //   title: 'Draw Irrigation Main'
          // },
          // {
          //   on: 'click',
          //   action: () => { addHeadAtGPS(); },
          //   classes: ['mapbox-gl-draw_ctrl-draw-btn', 'draw-irrigation-head-gps'],
          //   title: 'Add Sprinkler @ My Location'
          // },
        ]
      });

      context.map.addControl(new mapboxgl.NavigationControl());

      context.map.addControl(drawControl, 'top-right');

      // const drawIrrigationControl = new ExtendDrawBar({
      //   draw: context.Draw,
      //   buttons: [
      //     {
      //       on: 'click',
      //       action: () => {
      //         drawing = true;
      //         pendingProps = { layer: 'irrigation.main' };
      //         context.Draw.changeMode('draw_line_string')
      //       },
      //       classes: ['mapbox-gl-draw_ctrl-draw-btn','mapbox-gl-draw-irrigation-main'],
      //       title: 'Draw Irrigation Main'
      //     },
      //     {
      //       on: 'click',
      //       action: () => { addHeadAtGPS(); },
      //       classes: ['mapbox-gl-draw_ctrl-draw-btn', 'draw-irrigation-head-gps'],
      //       title: 'Add Sprinkler @ My Location'
      //     },
      //   ]
      // });

      // context.map.addControl(drawIrrigationControl, 'top-right');

      const editControl = new EditControl();
      context.map.addControl(editControl, 'top-right');

      const saveCancelControl = new SaveCancelControl();

      context.map.addControl(saveCancelControl, 'top-right');

      const trashControl = new TrashControl();

      context.map.addControl(trashControl, 'top-right');

      const exitEditMode = () => {
        editing = false;
        // show the data layers
        context.map.setLayoutProperty('map-data-fill', 'visibility', 'visible');
        context.map.setLayoutProperty(
          'map-data-fill-outline',
          'visibility',
          'visible'
        );
        context.map.setLayoutProperty('map-data-line', 'visibility', 'visible');

        // show markers
        d3.selectAll('.mapboxgl-marker').style('display', 'block');

        // clean up draw
        context.Draw.changeMode('simple_select');
        context.Draw.deleteAll();

        // hide the save/cancel control and the delete control
        d3.select('.save-cancel-control').style('display', 'none');
        d3.select('.trash-control').style('display', 'none');

        // show the edit button and draw tools
        maybeShowEditControl();
        d3.select('.mapboxgl-ctrl-group:nth-child(3)').style(
          'display',
          'block'
        );
      };

      // handle save or cancel from edit mode
      d3.selectAll('.mapboxgl-draw-actions-btn').on('click', function () {
        const target = d3.select(this);
        const isSaveButton = target.classed('mapboxgl-draw-actions-btn_save');
        if (isSaveButton) {
          const FC = context.Draw.getAll();
          context.data.set(
            {
              map: {
                ...FC,
                features: stripIds(FC.features)
              }
            },
            'map'
          );
        }

        exitEditMode();
      });

      // handle delete
      d3.select('.mapbox-gl-draw_trash').on('click', () => {
        context.Draw.trash();
      });

      // enter edit mode
      d3.selectAll('.mapbox-gl-draw_edit').on('click', () => {
        editing = true;
        // hide the edit button and draw tools
        d3.select('.edit-control').style('display', 'none');
        d3.select('.mapboxgl-ctrl-group:nth-child(3)').style('display', 'none');

        // show the save/cancel control and the delete control
        d3.select('.save-cancel-control').style('display', 'block');
        d3.select('.trash-control').style('display', 'block');

        // hide the line and polygon data layers
        context.map.setLayoutProperty('map-data-fill', 'visibility', 'none');
        context.map.setLayoutProperty(
          'map-data-fill-outline',
          'visibility',
          'none'
        );
        context.map.setLayoutProperty('map-data-line', 'visibility', 'none');

        // hide markers
        d3.selectAll('.mapboxgl-marker').style('display', 'none');

        // import the current data into draw for editing
        const featureIds = context.Draw.add(context.data.get('map'));
        context.Draw.changeMode('simple_select', {
          featureIds
        });
      });
    }

    function initializeMapResources() {
      if (context.map.getSource('map-data')) return;

      console.log("Initializing map sources and layers");
      let color = DEFAULT_DARK_FEATURE_COLOR;

      // Check for Standard Dark or Standard Satellite theme presets
      let config;
      try {
        const style = context.map.getStyle();
        if (style.imports && style.imports.length > 0) {
          config = context.map.getConfig('basemap');
        }
      } catch (e) {
        console.warn('Could not read map config for theme detection', e);
      }

      if (config) {
        if (config.theme === 'monochrome' && config.lightPreset === 'night') {
          color = DEFAULT_LIGHT_FEATURE_COLOR;
        }
        // Special case for Standard Satellite
        const styleInfo = context.map.getStyle();
        if (styleInfo.imports?.[0]?.data?.name === 'Mapbox Standard Satellite') {
          color = DEFAULT_SATELLITE_FEATURE_COLOR;
        }
      }

      context.map.addSource('map-data', {
        type: 'geojson',
        data: dummyGeojson
      });

      context.map.addLayer({
        id: 'map-data-fill',
        type: 'fill',
        source: 'map-data',
        paint: {
          'fill-color': ['coalesce', ['get', 'fill'], color],
          'fill-opacity': ['coalesce', ['get', 'fill-opacity'], 0.3]
        },
        filter: ['==', ['geometry-type'], 'Polygon']
      });

      context.map.addLayer({
        id: 'map-data-fill-outline',
        type: 'line',
        source: 'map-data',
        paint: {
          'line-color': ['coalesce', ['get', 'stroke'], color],
          'line-width': ['coalesce', ['get', 'stroke-width'], 2],
          'line-opacity': ['coalesce', ['get', 'stroke-opacity'], 1]
        },
        filter: ['==', ['geometry-type'], 'Polygon']
      });

      context.map.addLayer({
        id: 'map-data-line',
        type: 'line',
        source: 'map-data',
        paint: {
          'line-color': ['coalesce', ['get', 'stroke'], color],
          'line-width': ['coalesce', ['get', 'stroke-width'], 2],
          'line-opacity': ['coalesce', ['get', 'stroke-opacity'], 1]
        },
        filter: ['==', ['geometry-type'], 'LineString']
      });

      context.map.addLayer({
        id: 'map-data-point',
        type: 'circle',
        source: 'map-data',
        paint: {
          'circle-color': ['coalesce', ['get', 'marker-color'], color],
          'circle-radius': ['coalesce', ['get', 'point-radius'], 6],
          'circle-opacity': ['coalesce', ['get', 'fill-opacity'], 1],
          'circle-stroke-color': ['coalesce', ['get', 'stroke'], '#000'],
          'circle-stroke-width': ['coalesce', ['get', 'stroke-width'], 1]
        },
        filter: ['==', ['geometry-type'], 'Point']
      });

      // (optional) make them clickable like your other layers:
      context.map.on('click', 'map-data-point', (e) => bindPopup(e, context, writable));
      context.map.on('mouseenter', 'map-data-point', () => {
        if (context.Draw.getMode() === 'simple_select') context.map.getCanvas().style.cursor = 'pointer';
      });
      context.map.on('mouseleave', 'map-data-point', () => {
        if (context.Draw.getMode() === 'simple_select') context.map.getCanvas().style.removeProperty('cursor');
      });

      geojsonToLayer(context, writable);
    }

    context.map.on('error', (e) => {
      console.error('Mapbox error:', e.error?.message || e.error || 'Unknown map error');
    });

    context.map.on('idle', () => {
      if (context.data.get('mapStyleLoaded')) {
        initializeMapResources();
        context.data.set({ mapStyleLoaded: false });
      }
    });

    // only show projection toggle on zoom < 6
    context.map.on('zoomend', () => {
      const zoom = context.map.getZoom();
      if (zoom < 6) {
        d3.select('.projection-switch').style('opacity', 1);
      } else {
        d3.select('.projection-switch').style('opacity', 0);
      }
    });

    const maybeSetCursorToPointer = () => {
      if (context.Draw.getMode() === 'simple_select') {
        context.map.getCanvas().style.cursor = 'pointer';
      }
    };

    const maybeResetCursor = () => {
      if (context.Draw.getMode() === 'simple_select') {
        context.map.getCanvas().style.removeProperty('cursor');
      }
    };

    const handleLinestringOrPolygonClick = (e) => {
      // prevent this popup from opening when the original click was on a marker
      const el = e.originalEvent.target;
      console.log('Map Click detected:', {
        nodeName: el.nodeName,
        drawingState: drawing,
        editingState: editing,
        pointFeatures: context.data.get('map')?.features?.length
      });

      if (el.nodeName !== 'CANVAS') return;
      // prevent this popup from opening when drawing new features
      if (drawing) return;

      bindPopup(e, context, writable);
    };

    context.map.on('load', () => {
      console.log("Map load event fired");
      context.data.set({
        mapStyleLoaded: true
      });
      initializeMapResources();
      context.map.on('mouseenter', 'map-data-fill', maybeSetCursorToPointer);
      context.map.on('mouseleave', 'map-data-fill', maybeResetCursor);
      context.map.on('mouseenter', 'map-data-line', maybeSetCursorToPointer);
      context.map.on('mouseleave', 'map-data-line', maybeResetCursor);

      context.map.on('click', 'map-data-fill', handleLinestringOrPolygonClick);
      context.map.on('click', 'map-data-line', handleLinestringOrPolygonClick);
      context.map.on(
        'touchstart',
        'map-data-fill',
        handleLinestringOrPolygonClick
      );
      context.map.on(
        'touchstart',
        'map-data-line',
        handleLinestringOrPolygonClick
      );
    });

    context.map.on('style.load', () => {
      ensureEsriBase(context.map);
    });

    context.map.on('draw.create', created);

    function ensureEsriBase(map) {
      console.log("Loading ESRI map layer");
      // add source once per style
      if (!map.getSource('esri-world')) {
        map.addSource('esri-world', {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
          ],
          tileSize: 256,
          attribution: '© Esri, Maxar, Earthstar Geographics'
        });
      }

      // insert raster below labels
      const layers = map.getStyle().layers || [];
      const firstLabelId = layers.find(l => l.type === 'symbol' && l.layout && l.layout['text-field'])?.id;

      if (!map.getLayer('esri-world-layer')) {
        map.addLayer(
          { id: 'esri-world-layer', type: 'raster', source: 'esri-world', minzoom: 0, maxzoom: 19 },
          firstLabelId // may be undefined; then it's appended
        );
      }

      // hide original basemap (keep labels + our custom layers)
      for (const l of layers) {
        const isLabel = l.type === 'symbol';
        const isOurRaster = l.id === 'esri-world-layer';
        const isOurData = l.id && l.id.startsWith('map-data-'); // your feature layers
        if (!isLabel && !isOurRaster && !isOurData) {
          try { map.setLayoutProperty(l.id, 'visibility', 'none'); } catch { }
        }
      }
    }

    async function addHeadAtGPS() {
      if (!('geolocation' in navigator)) {
        console.warn('Geolocation not supported');
        return;
      }

      const getPosition = (opts) => new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, opts)
      );

      try {
        // Ask for high-accuracy GPS (mobile)
        const pos = await getPosition({
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        });

        const lng = pos.coords.longitude;
        const lat = pos.coords.latitude;

        // Create the sprinkler head feature
        const feature = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            layer: 'irrigation.sprinkler',
            source: 'gps',
            accuracy_m: Math.round(pos.coords.accuracy || 0),
            createdUtc: new Date().toISOString()
          }
        };

        // Add to your data model (reuses your existing update pipeline)
        update(stripIds([feature]));

        // Center/zoom to it so the user sees the drop
        context.map.easeTo({ center: [lng, lat], zoom: Math.max(context.map.getZoom(), 18) });

      } catch (err) {
        console.warn('Geolocation failed:', err);
        // Fallback for testing/desktop: Use map center
        console.log('Falling back to map center (Sprinkler)');
        const center = context.map.getCenter();
        const lng = center.lng;
        const lat = center.lat;

        // Create the sprinkler head feature
        const feature = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            layer: 'irrigation.sprinkler',
            source: 'manual_fallback',
            accuracy_m: 0,
            createdUtc: new Date().toISOString()
          }
        };
        update(stripIds([feature]));
      }
    }

    async function addPumpAtGPS() {
      if (!('geolocation' in navigator)) {
        console.warn('Geolocation not supported');
        return;
      }

      const getPosition = (opts) =>
        new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, opts)
        );

      try {
        const pos = await getPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
        const lng = pos.coords.longitude;
        const lat = pos.coords.latitude;

        const feature = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            layer: 'irrigation.pump',
            source: 'gps',
            accuracy_m: Math.round(pos.coords.accuracy || 0),
            createdUtc: new Date().toISOString(),
            'marker-color': '#0a8f5b',  // distinct from sprinkler
            'point-radius': 8
          }
        };

        update(stripIds([feature]));
        context.map.easeTo({ center: [lng, lat], zoom: Math.max(context.map.getZoom(), 18) });
        if (navigator.vibrate) navigator.vibrate(30);
      } catch (err) {
        console.warn('Geolocation failed:', err);
        // Fallback for testing/desktop: Use map center
        console.log('Falling back to map center (Pump)');
        const center = context.map.getCenter();
        const lng = center.lng;
        const lat = center.lat;

        const feature = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            layer: 'irrigation.pump',
            source: 'manual_fallback',
            accuracy_m: 0,
            createdUtc: new Date().toISOString(),
            'marker-color': '#0a8f5b',
            'point-radius': 8
          }
        };

        update(stripIds([feature]));
      }
    }

    function stripIds(features) {
      return features.map((feature) => {
        delete feature.id;
        return feature;
      });
    }

    function created(e) {
      e.features.forEach((f) => {
        // ensure properties exists
        f.properties = f.properties || {};

        // apply the tool’s pending properties (e.g., layer: 'irrigation.main')
        if (pendingProps) Object.assign(f.properties, pendingProps);

        // your existing golf defaulting
        if (isGolfLayer(f.properties.layer)) {
          if (!f.properties.hole) f.properties.hole = '';
        }
      });

      context.Draw.deleteAll();
      update(stripIds(e.features));

      // small delay you already have
      setTimeout(() => {
        drawing = false;
        pendingProps = null;   // <— reset so we don’t leak to the next draw
      }, 500);
    }

    function isGolfLayer(layerName) {
      return ['greens', 'bunkers', 'fairways', 'tees', 'drainage', 'irrigation.main'].includes(
        layerName
      );
    }

    function update(features) {
      let FC = context.data.get('map');

      FC.features = [...FC.features, ...features];

      FC = geojsonRewind(FC);

      context.data.set({ map: FC }, 'map');
    }

    context.dispatch.on('change.map', ({ obj }) => {
      maybeShowEditControl();
      if (obj.map) {
        geojsonToLayer(context, writable);
      }
    });
  }

  // --- Hamburger menu wiring ---
  function onHamburgerSave(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    if (window.context?.actions?.downloadGeoJSON) {
      window.context.actions.downloadGeoJSON(); // ✅ use original save
      if (navigator.vibrate) navigator.vibrate(20);
    } else {
      console.warn('downloadGeoJSON not found on context.actions');
    }
  }

  document.getElementById('menu-save')?.addEventListener('pointerup', onHamburgerSave, { passive: false });
  document.getElementById('menu-save')?.addEventListener('click', onHamburgerSave, { passive: false });

  return map;
};
