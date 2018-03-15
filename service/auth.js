'use strict';

const jwtChecker = require('express-jwt'),
    jwtConfig = require('../config/jwt'),
    peliasConfig = require( 'pelias-config' ).generate(require('../schema'));


/**
 * Reads configuration's API 'auth' key and determines auth method if any
 *
 * @returns {function} authentication method or done() statement
 */

function determineAuth() {  
    if (peliasConfig.api.auth === 'jwt') {
      return jwtChecker({
        secret: jwtConfig.secret,
        audience: jwtConfig.audience,
        issuer: jwtConfig.issuer
      });
    }
    else {
      return (req, res, done) => {
        done();
      };
    }
  }

    
module.exports = {
    determineAuth: determineAuth
};