const _ = require('lodash');
const path = require('path');
const requireAll = require('require-all');
const express = require('express');
const { Router } = express;
const sorting = require('pelias-sorting');
const elasticsearch = require('elasticsearch');
const {all, any, not} = require('predicates');

// imports
const sanitizers = requireAll(path.join(__dirname, '../sanitizer'));
const middleware = requireAll(path.join(__dirname, '../middleware'));
const controllers = requireAll(path.join(__dirname, '../controller'));
const queries = requireAll(path.join(__dirname, '../query'));

// predicates that drive whether controller/search runs
const predicates = requireAll(path.join(__dirname, '../controller/predicates'));
predicates.hasRequestCategories = predicates.hasRequestParameter('categories');

//checking for polygon geometries request parameter
const isPolygonRequest = require('../controller/predicates/polygons_parameter_present');

// shorthand for standard early-exit conditions
const hasResponseDataOrRequestErrors = any(predicates.hasResponseData, predicates.hasRequestErrors);
predicates.hasAdminOnlyResults = not(predicates.hasResultsAtLayers(['venue', 'address', 'street']));

const serviceWrapper = require('pelias-microservice-wrapper').service;
const configuration = requireAll(path.join(__dirname, '../service/configurations'));

/**
 * Append routes to app
 *
 * @param {object} app
 * @param {object} peliasConfig
 */

function addRoutes(app, peliasConfig) {
  const esclient = elasticsearch.Client(_.extend({}, peliasConfig.esclient));

  const pipConfiguration = new configuration.PointInPolygon(_.defaultTo(peliasConfig.api.services.pip, {}));
  const pipService = serviceWrapper(pipConfiguration);
  const isPipServiceEnabled = _.constant(pipConfiguration.isEnabled());

  const placeholderConfiguration = new configuration.PlaceHolder(_.defaultTo(peliasConfig.api.services.placeholder, {}));
  const placeholderService = serviceWrapper(placeholderConfiguration);
  const isPlaceholderServiceEnabled = _.constant(placeholderConfiguration.isEnabled());

  const changeLanguageConfiguration = new configuration.Language(_.defaultTo(peliasConfig.api.services.placeholder, {}));
  const changeLanguageService = serviceWrapper(changeLanguageConfiguration);
  const isChangeLanguageEnabled = _.constant(changeLanguageConfiguration.isEnabled());

  const interpolationConfiguration = new configuration.Interpolation(_.defaultTo(peliasConfig.api.services.interpolation, {}));
  const interpolationService = serviceWrapper(interpolationConfiguration);
  const isInterpolationEnabled = _.constant(interpolationConfiguration.isEnabled());

  // standard libpostal should use req.clean.text for the `address` parameter
  const libpostalConfiguration = new configuration.Libpostal(
    _.defaultTo(peliasConfig.api.services.libpostal, {}),
    _.property('clean.text'));
  const libpostalService = serviceWrapper(libpostalConfiguration);

  // structured libpostal should use req.clean.parsed_text.address for the `address` parameter
  const structuredLibpostalConfiguration = new configuration.Libpostal(
    _.defaultTo(peliasConfig.api.services.libpostal, {}),
    _.property('clean.parsed_text.address'));
  const structuredLibpostalService = serviceWrapper(structuredLibpostalConfiguration);

  // fallback to coarse reverse when regular reverse didn't return anything
  const coarseReverseShouldExecute = all(
    isPipServiceEnabled, not(predicates.hasRequestErrors), not(predicates.hasResponseData), not(predicates.isOnlyNonAdminLayers)
  );

  const libpostalShouldExecute = all(
    not(predicates.hasRequestErrors),
    not(predicates.isRequestSourcesOnlyWhosOnFirst)
  );

  // for libpostal to execute for structured requests, req.clean.parsed_text.address must exist
  const structuredLibpostalShouldExecute = all(
    not(predicates.hasRequestErrors),
    predicates.hasParsedTextProperties.all('address')
  );

  const placeholderGeodisambiguationShouldExecute = all(
    not(hasResponseDataOrRequestErrors),
    isPlaceholderServiceEnabled,
    // check request.clean for several conditions first
    not(
      any(
        // layers only contains venue, address, or street
        predicates.isOnlyNonAdminLayers,
        // don't geodisambiguate if categories were requested
        predicates.hasRequestCategories
      )
    ),
    any(
      predicates.isRequestSourcesOnlyWhosOnFirst,
      all(
        predicates.isAdminOnlyAnalysis,
        any(
          predicates.isRequestSourcesUndefined,
          predicates.isRequestSourcesIncludesWhosOnFirst
        )
      )
    )
  );

  // execute placeholder if libpostal identified address parts but ids need to
  //  be looked up for admin parts
  const placeholderIdsLookupShouldExecute = all(
    not(hasResponseDataOrRequestErrors),
    isPlaceholderServiceEnabled,
    predicates.isRequestLayersAnyAddressRelated,
    // check clean.parsed_text for several conditions that must all be true
    all(
      // run placeholder if clean.parsed_text has 'street'
      predicates.hasParsedTextProperties.any('street'),
      // don't run placeholder if there's a query or category
      not(predicates.hasParsedTextProperties.any('query', 'category')),
      // run placeholder if there are any adminareas identified
      predicates.hasParsedTextProperties.any('neighbourhood', 'borough', 'city', 'county', 'state', 'country')
    )
  );

  const searchWithIdsShouldExecute = all(
    not(predicates.hasRequestErrors),
    // don't search-with-ids if there's a query or category
    not(predicates.hasParsedTextProperties.any('query', 'category')),
    // at least one layer allowed by the query params must be related to addresses
    predicates.isRequestLayersAnyAddressRelated,
    // there must be a street
    predicates.hasParsedTextProperties.any('street')
  );

  // placeholder should have executed, useful for determining whether to actually
  //  fallback or not (don't fallback to old search if the placeholder response
  //  should be honored as is)
   const placeholderShouldHaveExecuted = any(
     placeholderGeodisambiguationShouldExecute,
     placeholderIdsLookupShouldExecute
   );

  const placeholderGeometriesShouldExecute = all(
      predicates.hasResponseData,
      isPolygonRequest
  );

  // don't execute the cascading fallback query IF placeholder should have executed
  //  that way, if placeholder didn't return anything, don't try to find more things the old way

  const fallbackQueryShouldExecute = all(
    not(predicates.hasRequestErrors),
    not(predicates.hasResponseData),
    not(placeholderShouldHaveExecuted)
  );

  const shouldDeferToPeliasParser = any(
    // we always want to try pelias parser based queries if there are no results
    not(predicates.hasResponseData),
    all(
      // if there are only admin results, but parse contains more granular items than admin,
      // then we want to defer to pelias parser based queries
      predicates.hasAdminOnlyResults,
      not(predicates.isAdminOnlyAnalysis),
      // exception: if the 'sources' parameter is only wof, do not use pelias parser
      // in that case Placeholder can return all the possible answers
      not(predicates.isRequestSourcesOnlyWhosOnFirst),
    )
  );

  // call search_pelias_parser query if pelias_parser was the parser
  const searchPeliasParserShouldExecute = all(
    not(predicates.hasRequestErrors),
    predicates.isPeliasParse
  );

  // get language adjustments if:
  // - there's a response
  // - theres's a lang parameter in req.clean
  const changeLanguageShouldExecute = all(
    predicates.hasResponseData,
    not(predicates.hasRequestErrors),
    isChangeLanguageEnabled,
    predicates.hasRequestParameter('lang')
  );

  // interpolate if:
  // - there's a number and street
  // - there are street-layer results (these are results that need to be interpolated)
  const interpolationShouldExecute = all(
    not(predicates.hasRequestErrors),
    isInterpolationEnabled,
    predicates.hasParsedTextProperties.all('housenumber', 'street'),
    predicates.hasResultsAtLayers('street')
  );

  // execute under the following conditions:
  // - there are no errors or data
  // - request is not coarse OR pip service is disabled
  const nonCoarseReverseShouldExecute = all(
    not(hasResponseDataOrRequestErrors),
    any(
      not(predicates.isCoarseReverse),
      not(isPipServiceEnabled)
    )
  );

  // helpers to replace vague booleans
  const geometricFiltersApply = true;

  const base = '/v1/';

  /** ------------------------- routers ------------------------- **/

  const routers = {
    index: createRouter([
      controllers.markdownToHtml(peliasConfig.api, './public/apiDoc.md')
    ]),
    attribution: createRouter([
      controllers.markdownToHtml(peliasConfig.api, './public/attribution.md')
    ]),
    search: createRouter([
      sanitizers.search.middleware(peliasConfig.api),
      middleware.requestLanguage,
      middleware.sizeCalculator(),
      controllers.libpostal(libpostalService, libpostalShouldExecute),
      controllers.placeholder(placeholderService, geometricFiltersApply, placeholderGeodisambiguationShouldExecute),
      controllers.placeholder(placeholderService, geometricFiltersApply, placeholderIdsLookupShouldExecute),
      controllers.placeholder_geometries(peliasConfig.api, esclient, placeholderGeometriesShouldExecute),
      // try 3 different query types: address search using ids, cascading fallback, pelias parser
      controllers.search(peliasConfig, esclient, queries.address_search_using_ids, searchWithIdsShouldExecute),
      controllers.search(peliasConfig, esclient, queries.search, fallbackQueryShouldExecute),
      sanitizers.defer_to_pelias_parser(peliasConfig.api, shouldDeferToPeliasParser), //run additional sanitizers needed for pelias parser
      controllers.search(peliasConfig, esclient, queries.search_pelias_parser, searchPeliasParserShouldExecute),
      middleware.trimByGranularity(),
      middleware.distance('focus.point.'),
      middleware.confidenceScore(peliasConfig.api),
      middleware.confidenceScoreFallback(),
      middleware.interpolate(interpolationService, interpolationShouldExecute, interpolationConfiguration),
      middleware.sortResponseData(sorting, predicates.hasAdminOnlyResults),
      middleware.dedupe(),
      middleware.accuracy(),
      middleware.localNamingConventions(),
      middleware.renamePlacenames(),
      middleware.parseBBox(),
      middleware.normalizeParentIds(),
      middleware.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      middleware.assignLabels(),
      middleware.geocodeJSON(peliasConfig.api, base),
      middleware.sendJSON
    ]),
    structured: createRouter([
      sanitizers.structured_geocoding.middleware(peliasConfig.api),
      middleware.requestLanguage,
      middleware.sizeCalculator(),
      controllers.structured_libpostal(structuredLibpostalService, structuredLibpostalShouldExecute),
      controllers.search(peliasConfig, esclient, queries.structured_geocoding, not(hasResponseDataOrRequestErrors)),
      middleware.trimByGranularityStructured(),
      middleware.distance('focus.point.'),
      middleware.confidenceScore(peliasConfig.api),
      middleware.confidenceScoreFallback(),
      middleware.interpolate(interpolationService, interpolationShouldExecute, interpolationConfiguration),
      middleware.dedupe(),
      middleware.accuracy(),
      middleware.localNamingConventions(),
      middleware.renamePlacenames(),
      middleware.parseBBox(),
      middleware.normalizeParentIds(),
      middleware.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      middleware.assignLabels(),
      middleware.geocodeJSON(peliasConfig.api, base),
      middleware.sendJSON
    ]),
    autocomplete: createRouter([
      sanitizers.autocomplete.middleware(peliasConfig.api),
      middleware.requestLanguage,
      middleware.sizeCalculator(),
      controllers.search(peliasConfig, esclient, queries.autocomplete, not(hasResponseDataOrRequestErrors)),
      middleware.distance('focus.point.'),
      middleware.confidenceScore(peliasConfig.api),
      middleware.dedupe(),
      middleware.accuracy(),
      middleware.localNamingConventions(),
      middleware.renamePlacenames(),
      middleware.parseBBox(),
      middleware.normalizeParentIds(),
      middleware.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      middleware.assignLabels(),
      middleware.geocodeJSON(peliasConfig.api, base),
      middleware.sendJSON
    ]),
    reverse: createRouter([
      sanitizers.reverse.middleware(peliasConfig.api),
      middleware.requestLanguage,
      middleware.sizeCalculator(2),
      controllers.search(peliasConfig, esclient, queries.reverse, nonCoarseReverseShouldExecute),
      controllers.coarse_reverse(pipService, coarseReverseShouldExecute),
      middleware.distance('point.'),
      // reverse confidence scoring depends on distance from origin
      //  so it must be calculated first
      middleware.confidenceScoreReverse(),
      middleware.dedupe(),
      middleware.accuracy(),
      middleware.localNamingConventions(),
      middleware.renamePlacenames(),
      middleware.parseBBox(),
      middleware.normalizeParentIds(),
      middleware.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      middleware.assignLabels(),
      middleware.geocodeJSON(peliasConfig.api, base),
      middleware.sendJSON
    ]),
    nearby: createRouter([
      sanitizers.nearby.middleware(peliasConfig.api),
      middleware.requestLanguage,
      middleware.sizeCalculator(),
      controllers.search(peliasConfig, esclient, queries.reverse, not(hasResponseDataOrRequestErrors)),
      middleware.distance('point.'),
      // reverse confidence scoring depends on distance from origin
      //  so it must be calculated first
      middleware.confidenceScoreReverse(),
      middleware.dedupe(),
      middleware.accuracy(),
      middleware.localNamingConventions(),
      middleware.renamePlacenames(),
      middleware.parseBBox(),
      middleware.normalizeParentIds(),
      middleware.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      middleware.assignLabels(),
      middleware.geocodeJSON(peliasConfig.api, base),
      middleware.sendJSON
    ]),
    place: createRouter([
      sanitizers.place.middleware(peliasConfig.api),
      middleware.requestLanguage,
      controllers.place(peliasConfig.api, esclient),
      middleware.expandDocument(peliasConfig.api, esclient),
      middleware.accuracy(),
      middleware.localNamingConventions(),
      middleware.renamePlacenames(),
      middleware.parseBBox(),
      middleware.normalizeParentIds(),
      middleware.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      middleware.assignLabels(),
      middleware.geocodeJSON(peliasConfig.api, base),
      middleware.sendJSON
    ]),
    status: createRouter([
      controllers.status
    ]),
    convert: createRouter([
      controllers.convert
    ])
  };

//Models
/**
   * @swagger
   * definitions:
   *   standardPeliasReturn:
   *     properties:
   *       geocoding:
   *         type: object
   *         $ref: '#/definitions/geocodingObject'
   *       type:
   *         type: string
   *       features:
   *         type: array
   *         items:
   *           $ref: '#/definitions/featureObject'
   *       bbox:
   *         type: array
   *         items: number
   *   standardPeliasErrorReturn:
   *     properties:
   *       geocoding:
   *         type: object
   *         $ref: '#/definitions/geocodingErrorObject'
   *       type:
   *         type: string
   *       features:
   *         type: array
   *         items:
   *           $ref: '#/definitions/featureObject'
   *       bbox:
   *         type: array
   *         items: number
   *   geocodingObject:
   *     properties:
   *       version:
   *         type: string
   *       attribution:
   *         type: string
   *       query:
   *         type: object
   *       engine:
   *         type: object
   *       timestamp:
   *         type: string
   *   geocodingErrorObject:
   *     properties:
   *       version:
   *         type: string
   *       attribution:
   *         type: string
   *       query:
   *         type: object
   *       errors:
   *         type: array
   *         items: string
   *       timestamp:
   *         type: string
   *   featureObject:
   *     properties:
   *       type:
   *         type: string
   *       geometry:
   *         type: object
   *       properties:
   *         type: object
   *       bbox:
   *         type: array
   *         items: number
   *   convertReturn:
   *     properties:
   *       type:
   *         type: string
   *       geometry:
   *         type: object
   *       properties:
   *         type: object
   *         $ref: '#/definitions/convertPropertiesObject'
   *       bbox:
   *         type: array
   *         items: number
   *   convertPropertiesObject:
   *     properties:
   *       from:
   *         type: string
   *       to:
   *         type: string
   *       name:
   *         type: string
   *   convertErrorReturn: 
   *     properties:
   *       errors:
   *         type: string
*/

  /**
   * @swagger
   * /v1:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: v1
   *     produces:
   *       - application/json
   *     summary: Landing page
   *     responses:
   *       200:
   *         description: 200 ok
   *         examples: 
   *           application/json: { "markdown": "# Pelias API\n### Version: [1.0](https://github.com/venicegeo/pelias-api/releases)\n### 
   * [View our documentation on GitHub](https://github.com/venicegeo/pelias-documentation/blob/master/README.md)\n", "html": "<style>ht
   * ml{font-family:monospace}</style><h1>Pelias API</h1>\n\n<h3>Version: <a href=\"https://github.com/venicegeo/pelias-api/releases\">
   * 1.0</a></h3>\n\n<h3><a href=\"https://github.com/venicegeo/pelias-documentation/blob/master/README.md\">View our documentation 
   * on GitHub</a></h3>" }
   */
  app.get ( base, routers.index );
  /**
   * @swagger
   * /v1/attribution:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: attribution
   *     produces:
   *       - application/json
   *     summary: landing page w/attribution
   *     responses:
   *       200:
   *         description: 200 ok
   *         examples: 
   *           application/json: {
   * "markdown": "# Pelias API\n### Version: [1.0](https://github.com/venicegeo/pelias-api/releases)\n
   * ### [View our documentation on GitHub](https://github.com/venicegeo/pelias-documentation/blob/master/README.md)\n
   * ## Attribution\n* Geocoding by [Pelias](https://pelias.io).\n* Data from\n   * [OpenStreetMap](http://www.openstreetmap.org/copyright)
   * © OpenStreetMap contributors under [ODbL](http://opendatacommons.org/licenses/odbl/). Also see the [OSM Geocoding Guidelines]
   * (https://wiki.osmfoundation.org/wiki/Licence/Community_Guidelines/Geocoding_-_Guideline) for acceptable use.\n   
   * * [OpenAddresses](http://openaddresses.io) under [various public-domain and share-alike licenses](http://results.openaddresses.io/)\n  
   * * [GeoNames](http://www.geonames.org/) under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)\n   * [WhosOnFirst]
   * (https://www.whosonfirst.org/) under [various CC-BY or CC-0 equivalent licenses](https://whosonfirst.org/docs/licenses/)",
   * "html": "<style>html{font-family:monospace}</style><h1>Pelias API</h1>\n\n<h3>Version: 
   * <a href=\"https://github.com/venicegeo/pelias-api/releases\">1.0</a></h3>\n\n<h3>
   * <a href=\"https://github.com/venicegeo/pelias-documentation/blob/master/README.md\">View our documentation on GitHub</a></h3>\n\n
   * <h2>Attribution</h2>\n\n<ul><li>Geocoding by <a href=\"https://pelias.io\">Pelias</a>.</li><li>Data from<ul><li>
   * <a href=\"http://www.openstreetmap.org/copyright\">OpenStreetMap</a> © OpenStreetMap contributors under 
   * <a href=\"http://opendatacommons.org/licenses/odbl/\">ODbL</a>. Also see the <a href=\"https://wiki.osmfoundation.org/wiki/
   * Licence/Community_Guidelines/Geocoding_-_Guideline\">OSM Geocoding Guidelines</a> for acceptable use.</li><li>
   * <a href=\"http://openaddresses.io\">OpenAddresses</a> under <a href=\"http://results.openaddresses.io/\">various 
   * public-domain and share-alike licenses</a></li><li><a href=\"http://www.geonames.org/\">GeoNames</a> under 
   * <a href=\"https://creativecommons.org/licenses/by/4.0/\">CC-BY-4.0</a></li><li><a href=\"https://www.whosonfirst.org/\">
   * WhosOnFirst</a> under <a href=\"https://whosonfirst.org/docs/licenses/\">various CC-BY or CC-0 equivalent licenses</a>
   * </li></ul></li></ul>"
   * }
   */
  app.get ( base + 'attribution', routers.attribution );
  app.get ( '/attribution', routers.attribution );
  /**
   * @swagger
   * /status:
   *   get:
   *     tags: 
   *       - base
   *     operationId: attribution
   *     produces:
   *       - text/plain
   *     summary: Landing page w/attribution
   *     responses:
   *       200:
   *         description: 200 ok
   *         examples: 
   *           text/plain: "status: ok"
   */
  app.get ( '/status', routers.status );

  // backend dependent endpoints

  /**
   * @swagger
   * /v1/place:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: place
   *     produces:
   *       - application/json
   *     summary: For querying specific place ID(s)
   *     parameters:
   *       - name: ids
   *         description: for details on a place returned from a previous query
   *         in: query
   *         required: true
   *         type: array
   *         items: {"type":"string", "pattern":"^[A-z]*.:[A-z]*.:[0-9]*$"}
   * 
   *     responses:
   *       200:
   *         description: 200 ok
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasReturn'
   *       400:
   *         description: 400 bad request
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasErrorReturn'
   */
  app.get ( base + 'place', routers.place );
  /**
   * @swagger
   * /v1/autocomplete:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: autocomplete
   *     summary: to give real-time result suggestions without having to type the whole location
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: text
   *         description: Text query
   *         in: query
   *         required: true
   *         type: string
   *       - name: focus.point.lat
   *         description: Focus point latitude
   *         in: query
   *         type: number
   *       - name: focus.point.lon
   *         description: Focus point longitude
   *         in: query
   *         type: number
   *       - name: boundary.rect.min_lon
   *         description: Bounding box minimum longitude
   *         in: query
   *         type: number
   *       - name: boundary.rect.max_lon
   *         description: Bounding box maximum longitude
   *         in: query
   *         type: number
   *       - name: boundary.rect.min_lat
   *         description: Bounding box minimum latitude
   *         in: query
   *         type: number
   *       - name: boundary.rect.max_lat
   *         description: Bounding box maximum latitude
   *         in: query
   *         type: number
   *       - name: sources
   *         description: Sources
   *         in: query
   *         type: string
   *         enum: [openstreetmap, openaddresses, whosonfirst, geonames]
   *       - name: layers
   *         description: Layers
   *         in: query
   *         type: string
   *         enum: [venue, address, street, country, macroregion, region, macrocounty, county,
   *                locality, localadmin, borough, neighbourhood, coarse]
   *       - name: boundary.county
   *         description: Country boundary
   *         in: query
   *         type: string
   *     responses:
   *       200:
   *         description: 200 ok
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasReturn'
   *       400:
   *         description: 400 bad request
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasErrorReturn'
   */
  app.get ( base + 'autocomplete', routers.autocomplete );
  /**
   * @swagger
   * /v1/search:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: search
   *     summary: to find a place by searching for an address or name
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: text
   *         description: Text query
   *         in: query
   *         required: true
   *         type: string
   *       - name: size
   *         description: used to limit the number of results returned.
   *         in: query
   *         type: number
   *     responses:
   *       200:
   *         description: 200 ok
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasReturn'
   *       400:
   *         description: 400 bad request
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasErrorReturn'
   *   post:
   *     tags: 
   *       - v1
   *     operationId: search
   *     summary: to find a place by searching for an address or name
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: text
   *         description: Text query
   *         in: query
   *         required: true
   *         type: string
   *       - name: size
   *         description: used to limit the number of results returned.
   *         in: query
   *         type: number
   *     responses:
   *       200:
   *         description: 200 ok
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasReturn'
   *       400:
   *         description: 400 bad request
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasErrorReturn'
   */

  app.get ( base + 'search', routers.search );
  app.post( base + 'search', routers.search );
  /**
   * @swagger
   * /v1/search/structured:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: structured
   *     summary: to find a place with data already separated into housenumber, street, city, etc.
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: text
   *         description: Text query
   *         in: query
   *         required: true
   *         type: string
   *       - name: venue
   *         description: WOF Venue
   *         in: query
   *         type: string
   *       - name: address
   *         description: can contain a full address with house number or only a street name.
   *         in: query
   *         type: string
   *       - name: neighbourhood
   *         description: vernacular geographic entities that may not necessarily be official administrative
   *                      divisions but are important nonetheless.
   *         in: query
   *         type: string
   *       - name: borough
   *         description: mostly known in the context of New York City, even though they may exist in other cities,
   *                      such as Mexico City.
   *         in: query
   *         type: string
   *       - name: locality
   *         description: equivalent to what are commonly referred to as cities.
   *         in: query
   *         type: string
   *       - name: county
   *         description: administrative divisions between localities and regions.
   *         in: query
   *         type: string
   *       - name: region
   *         description: the first-level administrative divisions within countries, analogous to states and provinces
   *                      in the United States and Canada, respectively, though most other countries contain regions
   *                      as well
   *         in: query
   *         type: string
   *       - name: postalcode
   *         description: used to aid in sorting mail with the format dictated by an administrative division
   *         in: query
   *         type: string
   *       - name: country
   *         description: highest-level administrative divisions supported in a search. In addition to full names,
   *                      countries have common two- and three-letter abbreviations that are also supported values for
   *                      the country parameter.
   *         in: query
   *         type: string
   *     responses:
   *       200:
   *         description: 200 ok
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasReturn'
   *       400:
   *         description: 400 bad request
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasErrorReturn'
   */
  app.get ( base + 'search/structured', routers.structured );
  /**
   * @swagger
   * /v1/reverse:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: reverse
   *     summary: to find what is located at a certain coordinate location
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: point.lat
   *         description: Latitude (decimal degrees)
   *         in: query
   *         required: true
   *         type: string
   *       - name: point.lon
   *         description: Longitude (decimal degrees)
   *         in: query
   *         required: true
   *         type: string
   *       - name: boundary.circle.radius
   *         description: Bounding circle radius
   *         in: query
   *         type: number
   *       - name: size
   *         description: used to limit the number of results returned.
   *         in: query
   *         type: number
   *       - name: sources
   *         description: one or more valid source names
   *         in: query
   *         type: string
   *         enum: [openstreetmap, openaddresses, whosonfirst, geonames]
   *       - name: layers
   *         description: Layers
   *         in: query
   *         type: string
   *         enum: [venue, address, street, country, macroregion, region, macrocounty, county, locality, localadmin,
   *                borough, neighbourhood, coarse]
   *       - name: boundary.county
   *         description: Country boundary
   *         in: query
   *         type: string
   *     responses:
   *       200:
   *         description: 200 ok
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasReturn'
   *       400:
   *         description: 400 bad request
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasErrorReturn'
   */
  app.get ( base + 'reverse', routers.reverse );
  /**
   * @swagger
   * /v1/nearby:
   *   get:
   *     tags: 
   *       - v1 
   *     operationId: nearby
   *     summary: reverse geocode search including surrounding areas
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: point.lat
   *         description: Latitude (decimal degrees)
   *         in: query
   *         required: true
   *         type: string
   *       - name: point.lon
   *         description: Longitude (decimal degrees)
   *         in: query
   *         required: true
   *         type: string
   *     responses:
   *       200:
   *         description: 200 ok
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasReturn'
   *       400:
   *         description: 400 bad request
   *         schema:
   *           type: object
   *           $ref: '#/definitions/standardPeliasErrorReturn'
   * 
   */
  app.get ( base + 'nearby', routers.nearby );
  /**
   * @swagger
   * /v1/convert:
   *   get:
   *     tags:
   *       - v1
   *     operationId: convert
   *     summary: proxy to the MGRS GEOTRANS conversion service
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: from
   *         description: Origin coordinate type
   *         in: query
   *         required: true
   *         type: string
   *         enum: ["decdeg", "mgrs"]
   *       - name: to
   *         description: Destination coordinate type
   *         in: query
   *         required: true
   *         type: string
   *         enum: ["decdeg", "mgrs"]
   *       - name: lat
   *         description: Latitude (decimal degrees) - Required on Decdeg -> MGRS conversion
   *         in: query
   *         type: string
   *       - name: lon
   *         description: Longitude (decimal degrees) - Required on Decdeg -> MGRS conversion
   *         in: query
   *         type: string
   *       - name: q
   *         description: MGRS coordinate - Required on MGRS -> Decdeg conversion
   *         in: query
   *         type: string
   *     responses:
   *       200:
   *         description: 200 ok
   *         schema:
   *           type: object
   *           $ref: '#/definitions/convertReturn'
   *       400:
   *         description: 400 bad request
   *         schema:
   *           type: object
   *           $ref: '#/definitions/convertErrorReturn'
   */
  app.get( base + 'convert', routers.convert );

  if (peliasConfig.api.exposeInternalDebugTools) {
    app.use ( '/frontend', express.static('node_modules/pelias-compare/dist-api/'));
  }
}
/**
 * Helper function for creating routers
 *
 * @param {[{function}]} functions
 * @returns {express.Router}
 */
function createRouter(functions) {
  var router = Router(); // jshint ignore:line
  functions.forEach((f) => {
    router.use(f);
  });
  return router;
}

module.exports.addRoutes = addRoutes;
