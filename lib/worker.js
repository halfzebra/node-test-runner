// @flow

var _ = require("lodash");

function run(dest) {
  fs.readFile(dest, { encoding: "utf8" }, function(readErr, compiledElmCode) {
    if (readErr) {
      console.error(
        "The test run failed because it could not read the compiled Elm code:\n\n",
        readErr
      );

      if (!args.watch) {
        process.exit(1);
      }
    }

    try {
      Runner.evalElmCode(args, report, compiledElmCode);
    } catch (err) {
      console.error(
        "The test run failed because of a runtime exception encountered when evaluating the compiled Elm code:\n\n",
        err
      );

      if (!args.watch) {
        process.exit(1);
      }
    }
  });
}

module.exports = WorkerProcess = {
  run: run
};
