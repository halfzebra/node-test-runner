var child_process = require("child_process");

var dest =
  "/Users/rtfeldman/code/node-test-runner/example/elm-stuff/generated-code/elm-community/elm-test/elmTestOutput.js";

console.log("forking", dest);
var worker = child_process.fork(dest);

process.on("message", function(data) {
  process.send("YO, i got" + data);
});
