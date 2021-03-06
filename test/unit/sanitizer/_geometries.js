const sanitizer = require('../../../sanitizer/_geometries')();

module.exports.tests = {};

module.exports.tests.do_nothing = (test, common) => {
  test('sanitize should return empty warnings/erros', t => {
    const messages = sanitizer.sanitize();

    t.deepEquals(messages.errors, [], 'no errors');
    t.deepEquals(messages.warnings, [], 'no warnings');
    t.end();

  });

};

module.exports.tests.expected = (test, common) => {
  test('expected should contain only \'geometries\'', t => {
    const expected = sanitizer.expected();

    t.deepEquals(expected, [{'name': 'geometries'}]);
    t.end();

  });
};

module.exports.all = (tape, common) => {
  function test(name, testFunction) {
    return tape(`SANITIZE _geometries: ${name}`, testFunction);
  }

  for( const testCase in module.exports.tests ){
    module.exports.tests[testCase](test, common);
  }
};
