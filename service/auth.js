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
        if(req.header('Authorization')){
          let jwtPayload = jwt.decode(req.header('Authorization').split(' ')[1]);
          if(jwtPayload.dn === process.env.GEOAXIS_DN && checkTime(jwtPayload.exp)){
            done();
          }
          else{
            res.status(401).send({ error: 'Invalid token' });
          }
        }
        else{
          res.status(401).send({ error: 'Missing token' });
        }
        let jwtPayload = jwt.decode(req.header('Authorization').split(' ')[1]);
        
      };
    }
    else {
      return (req, res, done) => {
        done();
      };
    }
  }

function checkTime(timeStamp){
  return timeStamp > Date.now() / 1000 | 0;
}
    
module.exports = {
    determineAuth: determineAuth
};