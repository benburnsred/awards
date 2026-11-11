// Runs the unit tests with Node:  node tests/run.js
// Exits with an error if any test fails, so GitHub shows a red ✗ on the commit.
const fs = require('fs'), path = require('path');
const Harness = require('./harness.js'), AxaTests = require('./tests.js');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const results = AxaTests(Harness, {code: read('apps-script/Code.gs'), admin: read('apps-script/Admin.html'), vote: read('vote/index.html')});
let group = '';
results.forEach(r => {
  if (r.group !== group) console.log('\n' + (group = r.group));
  console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.name + (r.ok ? '' : '\n      ' + r.error));
});
const failed = results.filter(r => !r.ok).length;
console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
