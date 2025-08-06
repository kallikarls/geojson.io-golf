// src/ui/draw/green.js
const MapboxDraw = require('@mapbox/mapbox-gl-draw').default;

const DrawGreen = {
  ...MapboxDraw.modes.draw_polygon,

  onSetup: function (opts) {
    // Call the original onSetup to get polygon drawing working
    const state = MapboxDraw.modes.draw_polygon.onSetup.call(this, opts);

    // Set custom default properties for the new feature
    const feature = this.getFeature(state.polygon.id);
    if (feature) {
      feature.properties.layer = 'greens';
      feature.properties.hole = '';
      feature.properties.fill = '#00aa00'; // use 'fill' so it works with your style filter
    }

    return state;
  },

  onStop: function (state) {
    this.updateUIClasses({ mouse: 'none' });
    this.activateUIButton();

    if (this.getFeature(state.polygon.id) === undefined) return;

    if (state.polygon.isValid()) {
      this.map.fire('draw.create', {
        features: [state.polygon.toGeoJSON()]
      });
    } else {
      this.deleteFeature([state.polygon.id], { silent: true });
      this.changeMode('simple_select', {}, { silent: true });
    }
  },

  toDisplayFeatures: function (state, geojson, display) {
    return MapboxDraw.modes.draw_polygon.toDisplayFeatures.call(
      this,
      state,
      geojson,
      display
    );
  },

  onTrash: function (state) {
    this.deleteFeature([state.polygon.id], { silent: true });
    this.changeMode('simple_select');
  }
};

module.exports = DrawGreen;
