var _rtfeldman$node_test_runner$Native_RunTest = (function() {
  try {
    return {
      send: function(str) {
        console.log("= = SENDING STR", str);
        return _elm_lang$core$Native_Scheduler.nativeBinding(function(
          callback
        ) {
          console.log("inside binding");
          process.send(str);

          callback(
            _elm_lang$core$Native_Scheduler.succeed(
              _elm_lang$core$Native_Utils.Tuple0
            )
          );
        });
      },

      messages: function(toTask) {
        console.log("calling msgs");
        function performTask(message) {
          console.log("__ PERF TASK");
          _elm_lang$core$Native_Scheduler.rawSpawn(toTask(message));
          console.log("__ PERF TASK DONE");
        }

        process.on("message", performTask);
        console.log("init Messages");
        return _elm_lang$core$Native_Scheduler.nativeBinding(function(
          callback
        ) {
          console.log("DOIN STUFF");

          return function() {
            process.off("message", performTask);
          };
        });
      },

      runThunk: function(thunk) {
        try {
          // Attempt to run the thunk as normal.
          return thunk({ ctor: "_Tuple0" });
        } catch (err) {
          // If it throws, return a test failure instead of crashing.
          return {
            ctor: "::",
            _0: _elm_community$elm_test$Expect$fail(
              'This test failed because it threw an exception: "' + err + '"'
            ),
            _1: { ctor: "[]" }
          };
        }
      }
    };
  } catch (err) {
    console.log("ERR: ", err);
    process.send("ERR");
  } finally {
    console.log("startup worked");
  }
})();
