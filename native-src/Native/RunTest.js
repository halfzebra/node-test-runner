var _rtfeldman$node_test_runner$Native_RunTest = (function() {
  function performTask(message) {
    console.log("received message:", message);
    _elm_lang$core$Native_Scheduler.rawSpawn(
      _elm_lang$core$Task$succeed(message)
    );
  }

  // It's essential that we do this now. If the node process does not
  // begin listening for "message" events, it will exit as soon as it finishes
  // its last statement. If this is not run on startup, the wroker will exit
  // rather than waiting for messages to come in.
  process.on("message", performTask);

  return {
    send: function(str) {
      console.log("= = SENDING STR", str);
      return _elm_lang$core$Native_Scheduler.nativeBinding(function(callback) {
        console.log("inside binding");
        process.send(str);

        callback(
          _elm_lang$core$Native_Scheduler.succeed(
            _elm_lang$core$Native_Utils.Tuple0
          )
        );
      });
    },

    messages: _elm_lang$core$Native_Scheduler.nativeBinding(function(callback) {
      console.log("DOIN STUFF");

      return function() {
        process.off("message", performTask);
      };
    }),

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
})();
