const _ = require('lodash');
const Debug = require('../../helper/debug');
const debugLog = new Debug('controller:predicates:polygons_parameter_present');
const stackTraceLine = require('../../helper/stackTraceLine');

module.exports = (request, response) => {
    let geometries = request.query.geometries || undefined;
    let polygonPresent = false;
    if( geometries ) {
        const validType = 'polygon';
        const requestedGeometries = geometries.split(',');
        requestedGeometries.forEach(entry => {
            if(validType === entry)
        {
            polygonPresent = true;
        }
    });

    }

    debugLog.push(request, () => ({
            reply: polygonPresent,
            stack_trace: stackTraceLine()
        })
    );
    return polygonPresent;
};
