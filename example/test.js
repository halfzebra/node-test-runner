var child_process = require("child_process");

var dest =
  "/Users/rtfeldman/code/node-test-runner/example/elm-stuff/generated-code/elm-community/elm-test/elmTestOutput.js";

console.log("forking", dest);
var worker = child_process.fork(dest);

worker.on("message", function(data) {
  console.log("[WORKER]", data);
});

console.log("sending message to worker");
worker.send("0");
console.log("sent message to worker");
