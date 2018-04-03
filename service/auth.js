'use strict';

const jwtChecker = require('express-jwt'),
    peliasConfig = require( 'pelias-config' ).generate(require('../schema'));
    




/**
 * Reads configuration's API 'auth' key and determines auth method if any
 *
 * @returns {function} authentication method or done() statement
 */

function determineAuth() {  
    if (peliasConfig.api.auth === 'jwt') {
      return jwtChecker({
        secret: process.env.JWT_SECRET,
        audience: process.env.JWT_AUDIENCE,
        issuer: process.env.JWT_ISSUER
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