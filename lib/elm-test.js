// @flow

var processTitle = "elm-test";

process.title = processTitle;

process.on("uncaughtException", function(error) {
  if (/ an argument in Javascript/.test(error)) {
    // Handle arg mismatch between js and elm code. Expected message from Elm:
    // "You are giving module `Main` an argument in JavaScript.
    // This module does not take arguments though! You probably need to change the
    // initialization code to something like `Elm.Test.Generated.Main.fullscreen()`]"
    console.error("Error starting the node-test-runner.");
    console.error(
      "Please check your Javascript 'elm-test' and Elm 'node-test-runner' package versions are compatible"
    );
    process.exit(1);
  } else {
    console.error("Unhandled exception while running the tests:", error);
    process.exit(1);
  }
});

var compile = require("node-elm-compiler").compile,
  os = require("os"),
  fs = require("fs-extra"),
  crypto = require("crypto"),
  glob = require("glob"),
  chalk = require("chalk"),
  builder = require("xmlbuilder"),
  path = require("path"),
  util = require("util"),
  _ = require("lodash"),
  spawn = require("cross-spawn"),
  minimist = require("minimist"),
  firstline = require("firstline"),
  chokidar = require("chokidar"),
  Runner = require("./runner.js"),
  Init = require("./init.js"),
  child_process = require("child_process");

var generatedCodeDir = path.resolve(
  path.join("elm-stuff", "generated-code", "elm-community", "elm-test")
);
var args = minimist(process.argv.slice(2), {
  alias: {
    help: "h",
    fuzz: "f",
    seed: "s",
    compiler: "c",
    "add-dependencies": "a",
    report: "r",
    watch: "w"
  },
  boolean: ["warn", "version", "help", "watch"],
  string: ["add-dependencies", "compiler", "seed", "report", "fuzz"]
});

// Recursively search directories for *.elm files, excluding elm-stuff/
function resolveFilePath(filename) {
  var candidates;

  if (!fs.existsSync(filename)) {
    candidates = [];
  } else if (fs.lstatSync(filename).isDirectory()) {
    candidates = _.flatMap(
      glob.sync("/**/*.elm", {
        root: filename,
        nocase: true,
        ignore: "/**/elm-stuff/**",
        nodir: true
      }),
      resolveFilePath
    );
  } else {
    candidates = [path.resolve(filename)];
  }

  // Exclude everything having anything to do with elm-stuff
  return candidates.filter(function(candidate) {
    return candidate.split(path.sep).indexOf("elm-stuff") === -1;
  });
}

var pathToMake = undefined;

if (args.compiler !== undefined) {
  pathToMake = args.compiler;

  if (!pathToMake) {
    console.error(
      "The --compiler option must be given a path to an elm-make executable."
    );
    process.exit(1);
  }
}

function printUsage(str) {
  console.log("Usage: elm-test " + str + "\n");
}

if (args.help) {
  var exampleGlob = path.join("tests", "**", "*.elm");

  [
    "init # Create example tests",
    "TESTFILES # Run TESTFILES, for example " + exampleGlob,
    "[--compiler /path/to/compiler] # Run tests",
    "[--seed integer] # Run with initial fuzzer seed",
    "[--fuzz integer] # Run with each fuzz test performing this many iterations",
    "[--add-dependencies path-to-destination-elm-package.json] # Add missing dependencies from current elm-package.json to destination",
    "[--report json, junit, or chalk (default)] # Print results to stdout in given format",
    "[--version] # Print version string and exit",
    "[--watch] # Run tests on file changes"
  ].forEach(printUsage);

  process.exit(1);
}

if (args.version) {
  console.log(require(path.join(__dirname, "..", "package.json")).version);
  process.exit(0);
}

if (args["add-dependencies"]) {
  var target = args["add-dependencies"];

  if (fs.existsSync("elm-package.json")) {
    if (fs.existsSync(target)) {
      var elmPackageContents = {};
      var targetElmPackageContents = {};

      try {
        elmPackageContents = fs.readJsonSync("elm-package.json");
      } catch (err) {
        console.error("Error reading elm-package.json: " + err);
        process.exit(1);
      }

      try {
        targetElmPackageContents = fs.readJsonSync(target);
      } catch (err) {
        console.error("Error reading " + target + ": " + err);
        process.exit(1);
      }

      var newDeps = Object.assign(
        targetElmPackageContents.dependencies,
        elmPackageContents.dependencies
      );

      fs.writeFileSync(
        target,
        JSON.stringify(targetElmPackageContents, null, 4) + "\n"
      );

      console.log("Successfully updated dependencies in " + target);
      process.exit(0);
    } else {
      console.error(
        target +
          " does not exist.\n\nPlease re-run elm-test --add-dependencies with a target elm-package.json file (usually your tests' elm-package.json) that exists!"
      );
      process.exit(1);
    }
  } else {
    console.error(
      "There is no elm-package.json in this directory.\n\nPlease re-run elm-test --add-dependencies from a directory that contains an elm-package.json file!"
    );
    process.exit(1);
  }
}

var originalDir;
var elmRootDir;
var elmPackagePath;

function runTests(testFile) {
  var dest = path.resolve(path.join(generatedCodeDir, "elmTestOutput.js"));

  var compileProcess = compile([testFile], {
    output: dest,
    verbose: args.verbose,
    yes: true,
    spawn: spawnCompiler,
    pathToMake: pathToMake,
    warn: args.warn,
    processOpts: processOptsForReporter(args.report)
  });

  compileProcess.on("close", function(exitCode) {
    if (exitCode !== 0) {
      console.error("Compilation failed for", testFile);
      if (!args.watch) {
        process.exit(exitCode);
      }
    } else {
      var initialSeed = null;

      if (args.seed !== undefined) {
        initialSeed = args.seed;
      }
      prepareCompiledJsFile(initialSeed, report, dest);

      function finish() {
        // TODO take code from readAndEval to print summary and exit.
        console.log("FINSIHED!");
      }

      var cpus = os.cpus() || new Array(1);

      var nextTestToRun = -1;
      var finishedWorkers = 0;
      var closedWorkers = 0;

      function runNextTest(worker) {
        var testToRun = nextTestToRun;

        nextTestToRun++;

        // Immediately run the next test.
        worker.send("" + testToRun);
      }

      var workers = cpus.map(function(throwaway, index) {
        var worker = child_process.fork(dest);

        worker.on("close", function(code, signal) {
          closedWorkers++;

          // If all the workers have closed, we're done!
          if (closedWorkers === workers.length) {
            finish();
          }
        });

        worker.on("message", function(data) {
          console.log("[WORKER " + index + "]", data);

          var response = JSON.parse(data);
          switch (response.type) {
            case "FINISHED":
              // This worker found no tests remaining to run; it's finished!
              finishedWorkers++;

              // If all the workers have finished, print the summmary.
              if (finishedWorkers === workers.length) {
                // TODO send enough summary data that one worker can do this.
                worker.send("SUMMARY");
              }
              break;
            case "SUMMARY":
              // TODO print the summary.
              console.log("Received SUMMARY");

              // Close all the workers.
              workers.forEach(function(worker) {
                worker.kill();
              });
              break;
            case "BEGIN":
              // TODO record all the relevant values, and display the "hey we're
              // starting up here" thing to the user.
              console.log("Received BEGIN");

              runNextTest(worker);

              break;
            default:
              // TODO record the result!
              // TODO print progress bar - e.g. "Running test 5 of 20" on a bar!
              // -- yikes, be careful though...test the scenario where test
              // authors put Debug.log in their tests - does that mess
              // everything up re: the line feed? Seems like it would...
              // ...so maybe a bar is not best. Can we do better? Hm.

              runNextTest(worker);
          }
        });

        return worker;
      });

      // Set the workers running.
      workers.forEach(function(worker, index) {
        var testToRun = nextTestToRun;

        nextTestToRun++;

        if (testToRun === -1) {
          // The BEGIN message requests metadata about the test run, e.g.
          // how many tests will be run, whether they should auto-fail because
          // of skip/on/y/todo, etc.
          worker.send("BEGIN");
        } else {
          // Send the index of the test to run.
          worker.send("" + testToRun);
        }
      });
    }
  });
}

function prepareCompiledJsFile(initialSeed, report, dest) {
  // TODO read files in parallel using Promise.all
  var before = fs.readFileSync(
    path.join(__dirname, "..", "templates", "before.js"),
    "utf8"
  );
  var after = fs.readFileSync(
    path.join(__dirname, "..", "templates", "after.js"),
    "utf8"
  );
  var content = fs.readFileSync(dest, "utf8");

  var finalContent = [
    before,
    "var Elm = (function(module) { ",
    content,
    "return module.exports;",
    "})({});",
    "var initialSeed = " + initialSeed + ";",
    'var report = "' + report + '";',
    after
  ].join("\n");

  fs.writeFileSync(dest, finalContent);
}

function readAndEval(dest) {
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

function checkNodeVersion() {
  var nodeVersionString = process.versions.node;
  var nodeVersion = _.map(_.split(nodeVersionString, "."), _.parseInt);

  if (
    (nodeVersion[0] === 0 && nodeVersion[1] < 11) ||
    (nodeVersion[0] === 0 && nodeVersion[1] === 11 && nodeVersion[2] < 13)
  ) {
    console.log("using node v" + nodeVersionString);
    console.error(
      "elm-test requires node v4.7.0 or greater - upgrade the installed version of node and try again"
    );
    process.exit(1);
  }
}

function globify(filename) {
  return glob.sync(filename, {
    nocase: true,
    ignore: "**/elm-stuff/**",
    nodir: false
  });
}

function globifyWithRoot(root, filename) {
  return glob.sync(filename, {
    root: root,
    nocase: true,
    ignore: "**/elm-stuff/**",
    nodir: false
  });
}

function runElmTest() {
  checkNodeVersion();

  if (args._[0] == "init") {
    var cmdArgs = Init.init();
    var cmd = ["elm-package", "install", "--yes"].concat(cmdArgs).join(" ");

    child_process.execSync(cmd, { stdio: "inherit", cwd: Init.elmPackageDir });

    process.exit(0);
  }

  // It's important to globify all the arguments.
  // On Bash 4.x (or zsh), if you give it a glob as its last argument, Bash
  // translates that into a list of file paths. On bash 3.x it's just a string.
  // Ergo, globify all the arguments we receive.
  var filePathArgs = args._.length > 0 ? args._ : [];
  var getGlobs;

  if (filePathArgs.length > 0) {
    getGlobs = function() {
      return _.flatMap(filePathArgs, globify);
    };
  } else {
    var root = path.join(
      path.resolve(Runner.findNearestElmPackageDir([process.cwd()]))
    );

    getGlobs = function() {
      return globifyWithRoot(root, "test?(s)/**/*.elm");
    };
  }
  var globs = getGlobs();
  var testFilePaths = _.flatMap(globs, resolveFilePath);

  if (testFilePaths.length === 0) {
    var errorMessage =
      filePathArgs.length > 0
        ? 'No tests found for the file pattern "' +
          filePathArgs.toString() +
          '"\n\nMaybe try running elm-test with no arguments?'
        : "No tests found in the test/ (or tests/) directory.\n\nNOTE: Make sure you're running elm-test from your project's root directory, where its elm-package.json lives.\n\nTo generate some initial tests to get things going, run elm-test init";

    console.error(errorMessage);
    process.exit(1);
  }

  elmRootDir = path.resolve(Runner.findNearestElmPackageDir(testFilePaths));
  originalDir = path.resolve(
    Runner.findNearestElmPackageDir([path.resolve(elmRootDir, "..")])
  );
  elmPackagePath = path.resolve(path.join(elmRootDir, "elm-package.json"));

  if (elmRootDir === originalDir) {
    console.error(
      "It looks like you're running elm-test from within your tests directory.\n\nPlease run elm-test from your project's root directory, where its elm-package.json lives!"
    );
    process.exit(1);
  }

  process.chdir(elmRootDir);

  var returnValues = generatePackageJson(filePathArgs);
  var newElmPackageDir = returnValues[0];
  var generatedSrc = returnValues[1];
  var sourceDirs = returnValues[2];

  compileAllTests(testFilePaths)
    .then(function() {
      return Runner.findTests(elmRootDir, testFilePaths, sourceDirs)
        .then(function(runnableTests) {
          process.chdir(newElmPackageDir);

          // Copy our elm-stuff into the generated code, to avoid re-downloading
          // and re-building things we already just downloaded and built.
          var newElmStuffPath = path.join(newElmPackageDir, "elm-stuff");

          if (!fs.existsSync(newElmStuffPath)) {
            fs.mkdirpSync(newElmStuffPath);
            fs.copySync(path.join(elmRootDir, "elm-stuff"), newElmStuffPath);
          }

          generateAndRunTests(
            runnableTests,
            filePathArgs,
            generatedSrc,
            getGlobs
          );
        })
        .catch(function(err) {
          console.error(err);
          process.exit(1);
        });
    })
    .catch(function(err) {
      console.error(err);
      process.exit(1);
    });
}

function isMachineReadableReporter(reporter) {
  switch (reporter) {
    case "json":
    case "junit":
      return true;
    default:
      return false;
  }
}

function processOptsForReporter(reporter) {
  if (isMachineReadableReporter(reporter)) {
    return { stdio: ["ignore", "ignore", "pipe"] };
  } else {
    return {};
  }
}

// This compiles all the tests so that we generate *.elmi files for them,
// which we can then read to determine which tests need to be run.
function compileAllTests(testFilePaths) {
  return new Promise(function(resolve, reject) {
    var compileProcess = compile(testFilePaths, {
      output: "/dev/null",
      verbose: args.verbose,
      yes: true,
      spawn: spawnCompiler,
      pathToMake: pathToMake,
      warn: args.warn,
      processOpts: processOptsForReporter(args.report)
    });

    compileProcess.on("close", function(exitCode) {
      if (exitCode !== 0) {
        reject(
          "Compilation failed while attempting to build " +
            testFilePaths.join(" ")
        );
      } else {
        resolve();
      }
    });
  });
}

function generatePackageJson(filePathArgs) {
  // TODO we don't want to do this every single time. Instead,
  // verify that the generated elm-package.json is there, with the
  // expected version number. Iff the version number is wrong, regenerate.
  var newElmPackageDir = path.resolve(elmRootDir, generatedCodeDir);
  var generatedSrc = path.join(newElmPackageDir, "src");

  var elmPackageContents = {};

  try {
    elmPackageContents = fs.readJsonSync(elmPackagePath);
  } catch (err) {
    console.error("Error reading elm-package.json: " + err);
    process.exit(1);
  }

  // Enable Native modules in the new elm-package.json, so we can import
  // the function that translates runtime exceptions into test failures.
  elmPackageContents["native-modules"] = true;

  // TODO remove these next two conditionals once random-pcg has become core's new Random!
  if (!elmPackageContents.dependencies) {
    elmPackageContents.dependencies = {};
  }

  if (!elmPackageContents.dependencies.hasOwnProperty("mgold/elm-random-pcg")) {
    // Test.Runner.Node.App needs this to create a Seed from the current timestamp
    Object.assign(elmPackageContents.dependencies, {
      "mgold/elm-random-pcg": "4.0.2 <= v < 6.0.0"
    });
  }

  // Make all the source-directories absolute, and introduce a new one.
  var sourceDirs = (elmPackageContents["source-directories"] || [])
    .map(function(src) {
      return path.resolve(src);
    });

  elmPackageContents["source-directories"] = [
    // Include elm-stuff/generated-sources - since we'll be generating sources in there.
    generatedSrc,

    // Include node-test-runner's src directory, to allow access to the Runner code.
    path.resolve(path.join(__dirname, "..", "src"))
  ].concat(sourceDirs);

  fs.mkdirpSync(newElmPackageDir);

  // Generate the new elm-package.json
  fs.writeFileSync(
    path.join(newElmPackageDir, "elm-package.json"),
    JSON.stringify(elmPackageContents, null, 4)
  );

  // Copy all the native-src files over. These need to be "localized" - that is,
  // in js they cannot define things using rtfeldman$node_test_runner - but rather
  // must use the appropriate package name from the elm-package.json we're copying.
  Runner.copyNativeSrcFiles(
    Runner.repositoryToNativePackageName(elmPackageContents.repository),
    path.join(__dirname, "..", "native-src"),
    generatedSrc
  );

  return [newElmPackageDir, generatedSrc, sourceDirs];
}

function generateAndRunTests(tests, filePathArgs, generatedSrc, getGlobs) {
  // Building things like:
  //
  // import MyTests
  //
  // MyTests.suite
  var imports = _.map(tests, function(test) {
    return "import " + test.name;
  });
  var testList = _.map(tests, function(mod) {
    return (
      '    Test.describe "' +
      mod.name +
      '" [' +
      _.map(mod.tests, function(test) {
        return mod.name + "." + test;
      }).join(",\n    ") +
      "]"
    );
  });

  if (testList.length === 0) {
    var errorMessage =
      filePathArgs.length > 0
        ? "I couldn't find any exposed values of type Test in files matching \"" +
          filePathArgs.toString() +
          '"\n\nMaybe try running elm-test with no arguments?'
        : "I couldn't find any exposed values of type Test in any *.elm files in the test/ (or tests/) directory of your project's root directory.\n\nTo generate some initial tests to get things going, run elm-test init";

    console.error(errorMessage);
    process.exit(1);
  }

  function sanitizedToString(str) {
    return '"' + str.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  var fuzz = parseInt(args.fuzz);
  var seed = parseInt(args.seed);
  var opts = {
    fuzz: isNaN(fuzz) ? "Nothing" : "Just " + fuzz,
    seed: isNaN(seed) ? "Nothing" : "Just " + seed,
    reporter:
      typeof args.report === "undefined"
        ? "Nothing"
        : "Just " + sanitizedToString(args.report),
    paths: filePathArgs.map(sanitizedToString).join(",")
  };

  var optsCode =
    "{ runs = " +
    opts.fuzz +
    ", reporter = " +
    opts.reporter +
    ", seed = " +
    opts.seed +
    ", paths = [" +
    opts.paths +
    "]}";

  var testFileBody = [
    imports.join("\n"),
    "",
    "import Test.Runner.Node",
    "import Test",
    "import Json.Encode",
    "",
    "main : Test.Runner.Node.TestProgram",
    "main =",
    "    [ " + testList.join(", ") + " ]",
    "        |> Test.concat",
    "        |> Test.Runner.Node.runWithOptions " + optsCode
  ].join("\n");

  // Generate a filename that incorporates the hash of file contents.
  // Otherwise quickly re-running tests back to back will cause elm-make
  // to think it doesn't need to recompile anything, becuse the last
  // modified timestamp hasn't changed...leading to a busted test run!
  // TODO change this back to be just "Main" once elm-make uses
  // content hashes instead of last modified timestamp to detect changes.
  var salt = crypto.createHash("md5").update(testFileBody).digest("hex");
  var moduleName = "Main" + salt;
  var testFileContents = [
    "module Test.Generated." + moduleName + " exposing (main)",
    testFileBody
  ].join("\n\n");

  var testFile = path.join(generatedSrc, moduleName + ".elm");

  fs.writeFileSync(testFile, testFileContents);

  if (args.watch) {
    infoLog("Running in watch mode");

    function resolveWatchPath(basedir) {
      return function(filepath) {
        var basepath = path.isAbsolute(filepath)
          ? filepath
          : path.resolve(basedir, filepath);

        return basepath + "/**/*.elm";
      };
    }

    var watchedSourcePaths = fs
      .readJsonSync(path.join(originalDir, "elm-package.json"), "utf8")[
        "source-directories"
      ]
      .map(resolveWatchPath(originalDir));
    var watchedTestPaths = fs
      .readJsonSync(elmPackagePath, "utf8")["source-directories"]
      .map(resolveWatchPath(path.dirname(elmPackagePath)));
    var watchedPaths = watchedSourcePaths.concat(watchedTestPaths);

    var watcher = chokidar.watch(watchedPaths, {
      ignoreInitial: true,
      ignored: /(\/|^)elm-stuff(\/|$)/
    });

    var eventNameMap = {
      add: "added",
      addDir: "added",
      change: "changed",
      unlink: "removed",
      unlinkDir: "removed"
    };

    watcher.on("all", function(event, filePath) {
      var relativePath = path.relative(elmRootDir, filePath);
      var eventName = eventNameMap[event] || event;

      infoLog("\n" + relativePath + " " + eventName + ". Rebuilding!");

      // TODO if a previous run is in progress, wait until it's done.
      runTests(testFile);
    });
  }

  runTests(testFile);
}

var report;

if (
  args.report === "chalk" ||
  args.report === "json" ||
  args.report === "junit"
) {
  report = args.report;
} else if (args.report !== undefined) {
  console.error(
    "The --report option must be given either 'chalk', 'junit', or 'json'"
  );
  process.exit(1);
} else {
  report = "chalk";
}

function infoLog(msg) {
  if (report === "chalk") {
    console.log(msg);
  }
}

function spawnCompiler(cmd, args, opts) {
  var compilerOpts = _.defaults(
    {
      stdio: [
        process.stdin,
        report === "chalk" ? process.stdout : "ignore",
        process.stderr
      ]
    },
    opts
  );

  return spawn(cmd, args, compilerOpts);
}

runElmTest();
