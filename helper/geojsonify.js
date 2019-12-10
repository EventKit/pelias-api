const GeoJSON = require('geojson');
const extent = require('@mapbox/geojson-extent');
const logger = require('pelias-logger').get('geojsonify');
const collectDetails = require('./geojsonify_place_details');
const _ = require('lodash');
const Document = require('pelias-model').Document;
const codec = require('pelias-model').codec;
const field = require('./fieldValue');
const decode_gid = require('./decode_gid');


function geojsonifyPlaces(params, docs, geometriesParam, errors){

  // Parse geometries param for valid types
  let requestedGeometries = geometriesParam ? parseGeometries(geometriesParam, errors) : ['point'];

  // flatten & expand data for geojson conversion
  const geodata = docs.filter(doc => {
    if (!_.has(doc, 'center_point')) {
      logger.warn('No doc or center_point property');
      return false;
    } else {
      return true;
    }
  });

  // Initial parse to separate polygons and points on basis of request parameter.
  let parsedDocs = parseDocs(geodata, requestedGeometries);

  // Construct docs 
  const polygonData = parsedDocs.polygons.map(geojsonifyPlace.bind(null, params));
  const pointData = parsedDocs.points.map(geojsonifyPlace.bind(null, params));

  // Produce final place documents
  let pointGeojson = GeoJSON.parse( pointData, { Point: ['lat', 'lng'] });
  let polygonGeojson = generatePolygonGeojson(polygonData);
  //Create final combined geojson object
  pointGeojson.features = polygonGeojson.concat(pointGeojson.features);

  // get all the bounding_box corners as well as single points
  // to be used for computing the overall bounding_box for the FeatureCollection
  const extentPoints = extractExtentPoints(geodata.map(geojsonifyPlace.bind(null, params)));
  const geojsonExtentPoints = GeoJSON.parse( extentPoints, { Point: ['lat', 'lng'] });
  
  // to insert the bbox property at the top level of each feature, it must be done separately after
  // initial geojson construction is finished
  addBBoxPerFeature(pointGeojson);

  // bounding box calculations
  computeBBox(pointGeojson, geojsonExtentPoints);

  return pointGeojson;
}

/**
 * Separate polygons and points if geometries parameters indicates to do so
 *
 * @param {array} docs raw documents being fed to geojsonify
 * @param {string} requestedGeometries RES parameter string to split and parse as array
 * @returns {object} Returns object of polygons and points arrays accordingly
 */
function parseDocs(docs, requestedGeometries){
    //Check for polygon data 
    let polygonData = [];
    let pointData = [];
    const requestedPolygons = _.indexOf(requestedGeometries, 'polygon') > -1;
    const requestedPoints = _.indexOf(requestedGeometries, 'point') > -1;

    _.forEach(docs, doc => {
            
      if(_.has(doc, 'polygon')){
        if(requestedPolygons){
          polygonData.push(doc);
        }
        else{
          //Classify permanently as point data
          delete doc.polygon;
          if(requestedPoints){
            pointData.push(doc);
          }
        }
      }
      else if(requestedPoints){
          pointData.push(doc);
      }
    });
    return { polygons: polygonData, points: pointData };
}

/**
 * Generate polygon geojson object from ES document determined to have a polygon feature.
 *
 * @param {array} polygonData documents of data deemed to have polygons in them.
 * @returns {object} Returns geoJSON polygon or multi-polygon features in an array.
 */
function generatePolygonGeojson(polygonData){
  let polygonGeojson = [];
  _.forEach(polygonData, polygonPlace => {
    let properties = _.cloneDeep(_.omit(polygonPlace, ['geometry']));
    polygonGeojson.push({
      'type':'Feature',
      'geometry':polygonPlace.geometry,
      'properties':properties
    });
  });
  return polygonGeojson;
}


function geojsonifyPlace(params, place) {

  const gid_components = decode_gid(place._id);

  // setup the base doc
  const doc = {
    id: gid_components.id,
    gid: new Document(place.source, place.layer, gid_components.id).getGid(),
    layer: place.layer,
    source: place.source,
    source_id: gid_components.id,
    bounding_box: place.bounding_box,
  };
  
  // assign name, logging a warning if it doesn't exist
  if (_.has(place, 'name.default')) {
    doc.name = field.getStringValue(place.name.default);
  } else {
    logger.warn(`doc ${doc.gid} does not contain name.default`);
  }
  // assign geometry property if polygon data exists.
  if (_.has(place, 'polygon')) {
    doc.geometry = place.polygon;
  }
  else if(place.center_point){
      doc.lat = parseFloat(place.center_point.lat);
      doc.lng = parseFloat(place.center_point.lon);  
  }
  // assign all the details info into the doc
  Object.assign(doc, collectDetails(params, place));

  // add addendum data if available
  // note: this should be the last assigned property, for aesthetic reasons.
  if (_.has(place, 'addendum')) {
    let addendum = {};
    for(let namespace in place.addendum){
      try {
        addendum[namespace] = codec.decode(place.addendum[namespace]);
      } catch( e ){
        logger.warn(`doc ${doc.gid} failed to decode addendum namespace ${namespace}`);
      }
    }
    if( Object.keys(addendum).length ){
      doc.addendum = addendum;
    }
  }

  return doc;
}

/**
 * Add bounding box
 *
 * @param {object} geojson
 */
function addBBoxPerFeature(geojson) {
  geojson.features.forEach(feature => {
    if (feature.properties.bounding_box) {
      feature.bbox = [
        feature.properties.bounding_box.min_lon,
        feature.properties.bounding_box.min_lat,
        feature.properties.bounding_box.max_lon,
        feature.properties.bounding_box.max_lat
      ];
    }
    delete feature.properties.bounding_box;
  });
}

/**
 * Collect all points from the geodata.
 * If an item is a single point, just use that.
 * If an item has a bounding box, add two corners of the box as individual points.
 *
 * @param {Array} geodata
 * @returns {Array}
 */
function extractExtentPoints(geodata) {
  return geodata.reduce((extentPoints, place) => {
    // if there's a bounding_box, use the LL/UR for the extent
    if (place.bounding_box) {
      extentPoints.push({
        lng: place.bounding_box.min_lon,
        lat: place.bounding_box.min_lat
      },
      {
        lng: place.bounding_box.max_lon,
        lat: place.bounding_box.max_lat
      });
    }
    else {
      // otherwise, use the point for the extent
      extentPoints.push({
        lng: place.lng,
        lat: place.lat
      });
    }
    return extentPoints;

  }, []);

}

/**
 * Compute bbox that encompasses all features in the result set.
 * Set bbox property on the geojson object.
 *
 * @param {object} geojson
 */
function computeBBox(geojson, geojsonExtentPoints) {
  // @note: extent() sometimes throws Errors for unusual data
  // eg: https://github.com/pelias/pelias/issues/84
  try {
    const bbox = extent( geojsonExtentPoints );
    if( !!bbox ){
      geojson.bbox = bbox;
    }
  } catch( e ){
    logger.error( 'bbox error', e.message, e.stack );
    logger.error( 'geojson', geojsonExtentPoints );
  }
}

/**
 * Check that geometries parameter includes at least one valid geometry type if specified at all.
 * Otherwise default to point data.
 * @param {string} geometriesParam parameter to split and compare to valid types array.
 * @param {array} errorList list of errors to be displayed on geocoding result.
 * @returns {string} An array of
 */
function parseGeometries(geometriesParam, errorList){
    const validTypes = ['point','polygon'];
    const requestedGeometries = geometriesParam.split(',');
    let invalid = 0;
    requestedGeometries.forEach( entry => { 
      if(validTypes.indexOf(entry) === -1){
        errorList.push(entry + ' is not a valid geometry type');
        invalid++;
      }
    });
    return invalid < requestedGeometries.length ? requestedGeometries : [];
}

module.exports = geojsonifyPlaces;
