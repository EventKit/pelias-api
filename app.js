const app = require('express')();
const jwt = require('jsonwebtoken');

const peliasConfig = require( 'pelias-config' ).generate(require('./schema'));

const swaggerUi = require('express-swaggerize-ui');    

if( peliasConfig.api.accessLog ){
  app.use( require( './middleware/access_log' ).createAccessLogger( peliasConfig.api.accessLog ) );
}

app.use('/api-docs.json', function (req, res) {
  res.json(require('./docs.json'));
});
app.use('/api-docs', swaggerUi());
/** ----------------------- pre-processing-middleware ----------------------- **/

app.use( require('./middleware/headers') );
app.use( require('./middleware/cors') );
app.use( require('./middleware/options') );
app.use( require('./middleware/jsonp') );

/** ----------------------- routes ----------------------- **/


const defaultRoutes = require('./routes/default');
defaultRoutes.addRoutes(app);

const v1 = require('./routes/v1');
v1.addRoutes(app, peliasConfig);

/** ----------------------- error middleware ----------------------- **/

app.use( require('./middleware/404') );
app.use( require('./middleware/500') );

module.exports = app;
