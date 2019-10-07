const _ = require('lodash');
const logger = require('pelias-logger').get('api');
const mgetService = require('../service/mget');
const Debug = require('../helper/debug');
const debugLog = new Debug('controller:placeholder_geometries');

function setup(apiConfig, esclient, should_execute) {
  function controller(req, res, next) {
    // bail early if req/res don't pass conditions for execution
    const initialTime = debugLog.beginTimer(req);

    if (!should_execute(req, res)) {
      return next();
    }

    //generate old and new style Elasticsearch mget entries
    //New: the Elasticsearch ID is the Pelias GID, type not used
    //Old: the Elasticsearch ID is the Source ID, type is the layer
    const ids = res.data.map(function (doc) {
      return {
        _index: apiConfig.indexName,
        _id: doc._id
      };
    });

    const old_ids = res.data.map(function (doc) {
      return {
        _index: apiConfig.indexName,
        _type: doc.layer,
        _id: doc.source_id
      };
    });

    const cmd = old_ids.concat(ids);

    mgetService(esclient, cmd, (err, docs, data) => {
      if (err) {
        // push err.message or err onto req.errors
        req.errors.push(_.get(err, 'message', err));

      } else {

        res.meta = {
          query_type: 'search_fallback',
        };

        res.data = docs;

        const messageParts = [
          '[controller:placeholder_geometries]',
          `[result_count:${_.defaultTo(res.data, []).length}]`
        ];

        logger.info(messageParts.join(' '));
        debugLog.push(req, messageParts[1].slice(1, -1));
        debugLog.push(req, res.data);
      }

      debugLog.stopTimer(req, initialTime);
      return next();
    });

  }

  return controller;
}

module.exports = setup;