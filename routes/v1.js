const Router = require('express').Router,
      elasticsearch = require('elasticsearch'),
      all = require('predicates').all,
      any = require('predicates').any,
      not = require('predicates').not,
      _ = require('lodash'),
      jwt = require('jsonwebtoken'),
      jwtChecker = require('express-jwt'),
      peliasConfig = require( 'pelias-config' ).generate(require('../schema')),
      authService = require('../service/auth');

/** ----------------------- sanitizers ----------------------- **/
const sanitizers = {
  autocomplete: require('../sanitizer/autocomplete'),
  place: require('../sanitizer/place'),
  search: require('../sanitizer/search'),
  defer_to_addressit: require('../sanitizer/defer_to_addressit'),
  structured_geocoding: require('../sanitizer/structured_geocoding'),
  reverse: require('../sanitizer/reverse'),
  nearby: require('../sanitizer/nearby')
};

/** ----------------------- middleware ------------------------ **/
const middleware = {
  calcSize: require('../middleware/sizeCalculator'),
  requestLanguage: require('../middleware/requestLanguage')
};

/** ----------------------- controllers ----------------------- **/
const controllers = {
  coarse_reverse: require('../controller/coarse_reverse'),
  mdToHTML: require('../controller/markdownToHtml'),
  libpostal: require('../controller/libpostal'),
  structured_libpostal: require('../controller/structured_libpostal'),
  place: require('../controller/place'),
  placeholder: require('../controller/placeholder'),
  search: require('../controller/search'),
  search_with_ids: require('../controller/search_with_ids'),
  status: require('../controller/status'),
  convert: require('../controller/convert')
};

/** ----------------------- queries ----------------------- **/
const queries = {
  cascading_fallback: require('../query/search'),
  very_old_prod: require('../query/search_original'),
  structured_geocoding: require('../query/structured_geocoding'),
  reverse: require('../query/reverse'),
  autocomplete: require('../query/autocomplete'),
  address_using_ids: require('../query/address_search_using_ids')
};


/** ----------------------- post-processors ----------------------- **/
const postProc = {
  trimByGranularity: require('../middleware/trimByGranularity'),
  trimByGranularityStructured: require('../middleware/trimByGranularityStructured'),
  distances: require('../middleware/distance'),
  confidenceScores: require('../middleware/confidenceScore'),
  confidenceScoresFallback: require('../middleware/confidenceScoreFallback'),
  confidenceScoresReverse: require('../middleware/confidenceScoreReverse'),
  accuracy: require('../middleware/accuracy'),
  dedupe: require('../middleware/dedupe'),
  interpolate: require('../middleware/interpolate'),
  localNamingConventions: require('../middleware/localNamingConventions'),
  renamePlacenames: require('../middleware/renamePlacenames'),
  geocodeJSON: require('../middleware/geocodeJSON'),
  sendJSON: require('../middleware/sendJSON'),
  parseBoundingBox: require('../middleware/parseBBox'),
  normalizeParentIds: require('../middleware/normalizeParentIds'),
  assignLabels: require('../middleware/assignLabels'),
  changeLanguage: require('../middleware/changeLanguage'),
  sortResponseData: require('../middleware/sortResponseData')
};

// predicates that drive whether controller/search runs
const hasResponseData = require('../controller/predicates/has_response_data');
const hasRequestErrors = require('../controller/predicates/has_request_errors');
const isCoarseReverse = require('../controller/predicates/is_coarse_reverse');
const isAdminOnlyAnalysis = require('../controller/predicates/is_admin_only_analysis');
const hasResultsAtLayers = require('../controller/predicates/has_results_at_layers');
const isAddressItParse = require('../controller/predicates/is_addressit_parse');
const hasRequestCategories = require('../controller/predicates/has_request_parameter')('categories');
const isOnlyNonAdminLayers = require('../controller/predicates/is_only_non_admin_layers');
// this can probably be more generalized
const isRequestSourcesOnlyWhosOnFirst = require('../controller/predicates/is_request_sources_only_whosonfirst');
const hasRequestParameter = require('../controller/predicates/has_request_parameter');
const hasParsedTextProperties = require('../controller/predicates/has_parsed_text_properties');

// shorthand for standard early-exit conditions
const hasResponseDataOrRequestErrors = any(hasResponseData, hasRequestErrors);
const hasAdminOnlyResults = not(hasResultsAtLayers(['venue', 'address', 'street']));

const hasNumberButNotStreet = all(
  hasParsedTextProperties.any('number'),
  not(hasParsedTextProperties.any('street'))
);

const serviceWrapper = require('pelias-microservice-wrapper').service;
const PlaceHolder = require('../service/configurations/PlaceHolder');
const PointInPolygon = require('../service/configurations/PointInPolygon');
const Language = require('../service/configurations/Language');
const Interpolation = require('../service/configurations/Interpolation');
const Libpostal = require('../service/configurations/Libpostal');

/**
 * Append routes to app
 *
 * @param {object} app
 * @param {object} peliasConfig
 */

function addRoutes(app, peliasConfig) {
  const esclient = elasticsearch.Client(peliasConfig.esclient);

  const pipConfiguration = new PointInPolygon(_.defaultTo(peliasConfig.api.services.pip, {}));
  const pipService = serviceWrapper(pipConfiguration);
  const isPipServiceEnabled = _.constant(pipConfiguration.isEnabled());

  const placeholderConfiguration = new PlaceHolder(_.defaultTo(peliasConfig.api.services.placeholder, {}));
  const placeholderService = serviceWrapper(placeholderConfiguration);
  const isPlaceholderServiceEnabled = _.constant(placeholderConfiguration.isEnabled());

  const changeLanguageConfiguration = new Language(_.defaultTo(peliasConfig.api.services.placeholder, {}));
  const changeLanguageService = serviceWrapper(changeLanguageConfiguration);
  const isChangeLanguageEnabled = _.constant(changeLanguageConfiguration.isEnabled());

  const interpolationConfiguration = new Interpolation(_.defaultTo(peliasConfig.api.services.interpolation, {}));
  const interpolationService = serviceWrapper(interpolationConfiguration);
  const isInterpolationEnabled = _.constant(interpolationConfiguration.isEnabled());

  // standard libpostal should use req.clean.text for the `address` parameter
  const libpostalConfiguration = new Libpostal(
    _.defaultTo(peliasConfig.api.services.libpostal, {}),
    _.property('clean.text'));
  const libpostalService = serviceWrapper(libpostalConfiguration);

  // structured libpostal should use req.clean.parsed_text.address for the `address` parameter
  const structuredLibpostalConfiguration = new Libpostal(
    _.defaultTo(peliasConfig.api.services.libpostal, {}),
    _.property('clean.parsed_text.address'));
  const structuredLibpostalService = serviceWrapper(structuredLibpostalConfiguration);

  // fallback to coarse reverse when regular reverse didn't return anything
  const coarseReverseShouldExecute = all(
    isPipServiceEnabled, not(hasRequestErrors), not(hasResponseData)
  );

  const libpostalShouldExecute = all(
    not(hasRequestErrors),
    not(isRequestSourcesOnlyWhosOnFirst)
  );

  // for libpostal to execute for structured requests, req.clean.parsed_text.address must exist
  const structuredLibpostalShouldExecute = all(
    not(hasRequestErrors),
    hasParsedTextProperties.all('address')
  );

  // execute placeholder if libpostal only parsed as admin-only and needs to
  //  be geodisambiguated
  const placeholderGeodisambiguationShouldExecute = all(
    not(hasResponseDataOrRequestErrors),
    isPlaceholderServiceEnabled,
    // check request.clean for several conditions first
    not(
      any(
        // layers only contains venue, address, or street
        isOnlyNonAdminLayers,
        // don't geodisambiguate if categories were requested
        hasRequestCategories
      )
    ),
    any(
      // only geodisambiguate if libpostal returned only admin areas or libpostal was skipped
      isAdminOnlyAnalysis,
      isRequestSourcesOnlyWhosOnFirst
    )
  );

  // execute placeholder if libpostal identified address parts but ids need to
  //  be looked up for admin parts
  const placeholderIdsLookupShouldExecute = all(
    not(hasResponseDataOrRequestErrors),
    isPlaceholderServiceEnabled,
    // check clean.parsed_text for several conditions that must all be true
    all(
      // run placeholder if clean.parsed_text has 'street'
      hasParsedTextProperties.any('street'),
      // don't run placeholder if there's a query or category
      not(hasParsedTextProperties.any('query', 'category')),
      // run placeholder if there are any adminareas identified
      hasParsedTextProperties.any('neighbourhood', 'borough', 'city', 'county', 'state', 'country')
    )
  );

  const searchWithIdsShouldExecute = all(
    not(hasRequestErrors),
    // don't search-with-ids if there's a query or category
    not(hasParsedTextProperties.any('query', 'category')),
    // there must be a street
    hasParsedTextProperties.any('street')
  );

  // placeholder should have executed, useful for determining whether to actually
  //  fallback or not (don't fallback to old search if the placeholder response
  //  should be honored as is)
  const placeholderShouldHaveExecuted = any(
    placeholderGeodisambiguationShouldExecute,
    placeholderIdsLookupShouldExecute
  );

  // don't execute the cascading fallback query IF placeholder should have executed
  //  that way, if placeholder didn't return anything, don't try to find more things the old way
  const fallbackQueryShouldExecute = all(
    not(hasRequestErrors),
    not(hasResponseData),
    not(placeholderShouldHaveExecuted)
  );

  // defer to addressit for analysis IF there's no response AND placeholder should not have executed
  const shouldDeferToAddressIt = all(
    not(hasRequestErrors),
    not(hasResponseData),
    not(placeholderShouldHaveExecuted)
  );

  // call very old prod query if addressit was the parser
  const oldProdQueryShouldExecute = all(
    not(hasRequestErrors),
    isAddressItParse
  );

  // get language adjustments if:
  // - there's a response
  // - theres's a lang parameter in req.clean
  const changeLanguageShouldExecute = all(
    hasResponseData,
    not(hasRequestErrors),
    isChangeLanguageEnabled,
    hasRequestParameter('lang')
  );

  // interpolate if:
  // - there's a number and street
  // - there are street-layer results (these are results that need to be interpolated)
  const interpolationShouldExecute = all(
    not(hasRequestErrors),
    isInterpolationEnabled,
    hasParsedTextProperties.all('number', 'street'),
    hasResultsAtLayers('street')
  );

  // execute under the following conditions:
  // - there are no errors or data
  // - request is not coarse OR pip service is disabled
  const nonCoarseReverseShouldExecute = all(
    not(hasResponseDataOrRequestErrors),
    any(
      not(isCoarseReverse),
      not(isPipServiceEnabled)
    )
  );

  // helpers to replace vague booleans
  const geometricFiltersApply = true;
  const geometricFiltersDontApply = false;

  const base = '/v1/';

  /** ------------------------- routers ------------------------- **/

  const routers = {
    index: createRouter([
      controllers.mdToHTML(peliasConfig.api, './public/apiDoc.md')
    ]),
    attribution: createRouter([
      controllers.mdToHTML(peliasConfig.api, './public/attribution.md')
    ]),
    search: createRouter([
      sanitizers.search.middleware(peliasConfig.api),
      middleware.requestLanguage,
      middleware.calcSize(),
      controllers.libpostal(libpostalService, libpostalShouldExecute),
      controllers.placeholder(placeholderService, geometricFiltersApply, placeholderGeodisambiguationShouldExecute),
      controllers.placeholder(placeholderService, geometricFiltersDontApply, placeholderIdsLookupShouldExecute),
      controllers.search_with_ids(peliasConfig.api, esclient, queries.address_using_ids, searchWithIdsShouldExecute),
      // 3rd parameter is which query module to use, use fallback first, then
      //  use original search strategy if first query didn't return anything
      controllers.search(peliasConfig.api, esclient, queries.cascading_fallback, fallbackQueryShouldExecute),
      sanitizers.defer_to_addressit(shouldDeferToAddressIt),
      controllers.search(peliasConfig.api, esclient, queries.very_old_prod, oldProdQueryShouldExecute),
      postProc.trimByGranularity(),
      postProc.distances('focus.point.'),
      postProc.confidenceScores(peliasConfig.api),
      postProc.confidenceScoresFallback(),
      postProc.interpolate(interpolationService, interpolationShouldExecute),
      postProc.sortResponseData(require('pelias-sorting'), hasAdminOnlyResults),
      postProc.dedupe(),
      postProc.accuracy(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.normalizeParentIds(),
      postProc.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      postProc.assignLabels(),
      postProc.geocodeJSON(peliasConfig.api, base),
      postProc.sendJSON
    ]),
    structured: createRouter([
      sanitizers.structured_geocoding.middleware(peliasConfig.api),
      middleware.requestLanguage,
      middleware.calcSize(),
      controllers.structured_libpostal(structuredLibpostalService, structuredLibpostalShouldExecute),
      controllers.search(peliasConfig.api, esclient, queries.structured_geocoding, not(hasResponseDataOrRequestErrors)),
      postProc.trimByGranularityStructured(),
      postProc.distances('focus.point.'),
      postProc.confidenceScores(peliasConfig.api),
      postProc.confidenceScoresFallback(),
      postProc.interpolate(interpolationService, interpolationShouldExecute),
      postProc.dedupe(),
      postProc.accuracy(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.normalizeParentIds(),
      postProc.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      postProc.assignLabels(),
      postProc.geocodeJSON(peliasConfig.api, base),
      postProc.sendJSON
    ]),
    autocomplete: createRouter([
      sanitizers.autocomplete.middleware(peliasConfig.api),
      middleware.requestLanguage,
      controllers.search(peliasConfig.api, esclient, queries.autocomplete, not(hasResponseDataOrRequestErrors)),
      postProc.distances('focus.point.'),
      postProc.confidenceScores(peliasConfig.api),
      postProc.dedupe(),
      postProc.accuracy(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.normalizeParentIds(),
      postProc.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      postProc.assignLabels(),
      postProc.geocodeJSON(peliasConfig.api, base),
      postProc.sendJSON
    ]),
    reverse: createRouter([
      sanitizers.reverse.middleware,
      middleware.requestLanguage,
      middleware.calcSize(),
      controllers.search(peliasConfig.api, esclient, queries.reverse, nonCoarseReverseShouldExecute),
      controllers.coarse_reverse(pipService, coarseReverseShouldExecute),
      postProc.distances('point.'),
      // reverse confidence scoring depends on distance from origin
      //  so it must be calculated first
      postProc.confidenceScoresReverse(),
      postProc.dedupe(),
      postProc.accuracy(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.normalizeParentIds(),
      postProc.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      postProc.assignLabels(),
      postProc.geocodeJSON(peliasConfig.api, base),
      postProc.sendJSON
    ]),
    nearby: createRouter([
      sanitizers.nearby.middleware,
      middleware.requestLanguage,
      middleware.calcSize(),
      controllers.search(peliasConfig.api, esclient, queries.reverse, not(hasResponseDataOrRequestErrors)),
      postProc.distances('point.'),
      // reverse confidence scoring depends on distance from origin
      //  so it must be calculated first
      postProc.confidenceScoresReverse(),
      postProc.dedupe(),
      postProc.accuracy(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.normalizeParentIds(),
      postProc.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      postProc.assignLabels(),
      postProc.geocodeJSON(peliasConfig.api, base),
      postProc.sendJSON
    ]),
    place: createRouter([
      sanitizers.place.middleware,
      middleware.requestLanguage,
      controllers.place(peliasConfig.api, esclient),
      postProc.accuracy(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.normalizeParentIds(),
      postProc.changeLanguage(changeLanguageService, changeLanguageShouldExecute),
      postProc.assignLabels(),
      postProc.geocodeJSON(peliasConfig.api, base),
      postProc.sendJSON
    ]),
    status: createRouter([
      controllers.status
    ]),
    convert: createRouter([
      controllers.convert
    ])
  };

  //Set authorization method based on pelias config
  let authMethod = authService.determineAuth();



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
   *     summary: Landing page w/attribution
   *     responses:
   *       200:
   *         description: 200 ok
   *         examples: 
   *           application/json: {  "markdown": "# Pelias API\n### Version: [1.0]
   * (https://github.com/venicegeo/pelias-api/releases)\n### [View our documentation 
   * on GitHub](https://github.com/venicegeo/pelias-documentation/blob/master/README.md)
   * \n## Attribution\n* Geocoding by [Pelias](https://mapzen.com/pelias) from [Mapzen]
   * (https://mapzen.com)\n* Data from\n   * [OpenStreetMap](http://www.openstreetmap.org/copyright)
   *  © OpenStreetMap contributors under [ODbL](http://opendatacommons.org/licenses/odbl/)\n 
   *   * [OpenAddresses](http://openaddresses.io) under a 
   * [Creative Commons Zero](https://github.com/openaddresses/openaddresses/blob/master/sources/LICENSE) 
   * public domain designation\n   * [GeoNames](http://www.geonames.org/) under 
   * [CC-BY-3.0](https://creativecommons.org/licenses/by/2.0/)\n   * [WhosOnFirst](http://whosonfirst.mapzen.com) 
   * under [various licenses](https://github.com/whosonfirst/whosonfirst-data/blob/master/LICENSE.md)\n   
   * * [Geographic Names Database](http://geonames.nga.mil/gns/html/index.html)\n",  
   * "html": "<style>html{font-family:monospace}</style><h1>Pelias API</h1>\n\n
   * <h3>Version: <a href=\"https://github.com/venicegeo/pelias-api/releases\">1.0</a></h3>\n\n
   * <h3><a href=\"https://github.com/venicegeo/pelias-documentation/blob/master/README.md\">View our documentation on GitHub</a></h3>
   * \n\n<h2>Attribution</h2>\n\n<ul><li>Geocoding by <a href=\"https://mapzen.com/pelias\">Pelias</a> from 
   * <a href=\"https://mapzen.com\">Mapzen</a></li><li>Data from<ul><li><a href=\"http://www.openstreetmap.org/copyright\">
   * OpenStreetMap</a> © OpenStreetMap contributors under <a href=\"http://opendatacommons.org/licenses/odbl/\">
   * ODbL</a></li><li><a href=\"http://openaddresses.io\">OpenAddresses</a> under a 
   * <a href=\"https://github.com/openaddresses/openaddresses/blob/master/sources/LICENSE\">Creative Commons Zero</a> 
   * public domain designation</li><li><a href=\"http://www.geonames.org/\">GeoNames</a> under 
   * <a href=\"https://creativecommons.org/licenses/by/2.0/\">CC-BY-3.0</a></li><li><a href=\"http://whosonfirst.mapzen.com\">
   * WhosOnFirst</a>*  under <a href=\"https://github.com/whosonfirst/whosonfirst-data/blob/master/LICENSE.md\">various
   *  licenses</a></li>* <li><a href=\"http://geonames.nga.mil/gns/html/index.html\">Geographic Names Database</a></li></ul>
   * </li></ul>"}
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
   *         description: Specific place ID(s) to query.
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
   *     summary: Standard text query w/greater flexibility with partial matches and incomplete wording.
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: text
   *         description: Text query
   *         in: query
   *         required: true
   *         type: string
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
  app.get ( base + 'autocomplete', routers.autocomplete );
  /**
   * @swagger
   * /v1/search:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: search
   *     summary: Standard text query search.
   *     produces:
   *       - application/json
   *     parameters:
   *       - name: text
   *         description: Text query
   *         in: query
   *         required: true
   *         type: string
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
  app.get ( base + 'search', authMethod, routers.search );
  app.post( base + 'search', authMethod, routers.search );
  /**
   * @swagger
   * /v1/search/structured:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: structured
   *     summary: Standard text query with filtering by standard WOF properties.
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
   *         description: Address
   *         in: query
   *         type: string
   *       - name: neighbourhood
   *         description: Neighbourhood
   *         in: query
   *         type: string
   *       - name: borough
   *         description: Borough
   *         in: query
   *         type: string
   *       - name: locality
   *         description: Locality
   *         in: query
   *         type: string
   *       - name: county
   *         description: County
   *         in: query
   *         type: string
   *       - name: region
   *         description: Region
   *         in: query
   *         type: string
   *       - name: postalcode
   *         description: Postal Code
   *         in: query
   *         type: string
   *       - name: country
   *         description: Country
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
   *   post:
   *     tags: 
   *       - v1
   *     operationId: structured
   *     summary: Standard text query with filtering by standard WOF properties.
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
   *         description: Address
   *         in: query
   *         type: string
   *       - name: neighbourhood
   *         description: Neighbourhood
   *         in: query
   *         type: string
   *       - name: borough
   *         description: Borough
   *         in: query
   *         type: string
   *       - name: locality
   *         description: Locality
   *         in: query
   *         type: string
   *       - name: county
   *         description: County
   *         in: query
   *         type: string
   *       - name: region
   *         description: Region
   *         in: query
   *         type: string
   *       - name: postalcode
   *         description: Postal Code
   *         in: query
   *         type: string
   *       - name: country
   *         description: Country
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
  app.get ( base + 'search/structured', authMethod, routers.structured );
  /**
   * @swagger
   * /v1/reverse:
   *   get:
   *     tags: 
   *       - v1
   *     operationId: reverse
   *     summary: Reverse geocode search.
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
   */
  app.get ( base + 'reverse', authMethod, routers.reverse );
  /**
   * @swagger
   * /v1/nearby:
   *   get:
   *     tags: 
   *       - v1 
   *     operationId: nearby
   *     summary: Reverse geocode search including surrounding areas.
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
   *     summary: Proxy to the MGRS GEOTRANS Conversion service.
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
  app.get ( base + 'convert', authMethod, routers.convert );
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
