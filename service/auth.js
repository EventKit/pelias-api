'use strict';

const jwtChecker = require('express-jwt'),
    peliasConfig = require( 'pelias-config' ).generate(require('../schema')),
    jwt = require('jsonwebtoken');
    




/**
 * Reads configuration's API 'auth' key and determines auth method if any
 *
 * @returns {function} authentication method or done() statement
 */

function determineAuth() {  
    if (peliasConfig.api.auth === 'jwt') {
      return jwtChecker({
        secret: process.env.JWT_SECRET
      });
    }
    else if(peliasConfig.api.auth === 'geoaxis_jwt') {
      return (req, res, done) => {
        if(jwt.decode(req.header('Authorization').split(' ')[1]).dn === process.env.GEOAXIS_DN){
          done();
        }
        else{
          res.status(401).send({ error: 'Unauthorized' });
        }
      };
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