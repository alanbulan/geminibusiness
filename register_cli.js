// Wrapper entry for the existing registration script so it can be run from
// a path without non-ASCII characters next to the main Python program.
// The actual implementation lives in the original directory.
const { main } = require('./register/main.js');
main();
