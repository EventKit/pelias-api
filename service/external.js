"use strict";

const logger = require( 'pelias-logger' ).get( 'api' );
const axios = require('axios');
const geotransIP = process.env.GEOTRANS_IP;
const geotransPort = process.env.GEOTRANS_PORT;

function geotrans(coord) { 
    let url = `http://${geotransIP}:${geotransPort}`;
    logger.info(`GET ${url}`);
    return axios.get(url, {
        params:{
            'datum':'WGE',
            'coord':coord
        }
    })
    .then(function (response){
        logger.info('200');
        logger.info(response.data);
        return response.data;
    }).catch(function (reason){
        logger.info('ERROR');
        logger.info(reason);
        return reason;
    });
}
  
module.exports = {
    geotrans: geotrans
};
