const peliasConfig = require('pelias-config').generate(require('../schema'));

const options = {
    'swaggerDefinition' : {
        'basePath': peliasConfig.api.basePath,
        'info': {
            'description': 'Swagger documentation for Pelias API',
            'title': 'Pelias API',
            'version': '1.0.0'
        },
        'securityDefinitions': {
            'JWT': {
                'type': 'apiKey',
                'name': 'Authorization',
                'in': 'header'
            }
        },
        'security': [
        { 'JWT': []}
        ]
    },

    'apis': ['./routes/*.js']
};

module.exports = options;