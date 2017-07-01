module Test.Runner.Node exposing (TestProgram, runWithOptions)

{-|


# Node Runner

Runs a test and outputs its results to the console. Exit code is 0 if tests
passed and 2 if any failed. Returns 1 if something went wrong.

@docs run, runWithOptions, TestProgram

-}

import Dict exposing (Dict)
import Expect exposing (Expectation)
import Json.Encode as Encode exposing (Value)
import Native.RunTest
import Platform
import Set exposing (Set)
import Task exposing (Task)
import Test exposing (Test)
import Test.Reporter.Reporter exposing (Report(..), TestReporter, createReporter)
import Test.Reporter.TestResults exposing (Failure, TestResult)
import Test.Runner exposing (Runner, SeededRunners(..))
import Test.Runner.Node.App as App
import Time exposing (Time)


{-| Execute the given thunk.

If it throws an exception, return a failure instead of crashing.

-}
runThunk : (() -> List Expectation) -> List Expectation
runThunk =
    Native.RunTest.runThunk


messages : (String -> Task x String) -> Sub String
messages toTask =
    Native.RunTest.messages toTask


send : String -> Task x ()
send str =
    Native.RunTest.send str


type alias TestId =
    Int


type alias Model =
    { available : Dict TestId Runner
    , running : Set TestId
    , queue : List TestId
    , startTime : Time
    , finishTime : Maybe Time
    , completed : List TestResult
    , testReporter : TestReporter
    , autoFail : Maybe String
    }


{-| A program which will run tests and report their results.
-}
type alias TestProgram =
    Platform.Program Value (App.Model Msg Model) (App.Msg Msg)


type alias Emitter msg =
    ( String, Value ) -> Cmd msg


type Msg
    = NoOp
    | Dispatch Int Time
    | Receive String
    | Complete TestId (List String) (List Expectation) Time Time
    | Finish Time


warn : String -> a -> a
warn str result =
    let
        _ =
            Debug.log str
    in
    result


update : Msg -> Model -> ( Model, Cmd Msg )
update msg ({ testReporter } as model) =
    case msg of
        NoOp ->
            ( model, Cmd.none )

        Finish finishTime ->
            let
                failed =
                    model.completed
                        |> List.filter (.expectations >> List.all ((/=) Expect.pass))
                        |> List.length

                duration =
                    finishTime - model.startTime

                summary =
                    testReporter.reportSummary duration model.autoFail model.completed

                exitCode =
                    if failed > 0 then
                        2
                    else if model.autoFail /= Nothing then
                        3
                    else
                        0

                cmd =
                    Encode.object
                        [ ( "type", Encode.string "FINISHED" )
                        , ( "exitCode", Encode.int exitCode )
                        , ( "format", Encode.string testReporter.format )
                        , ( "message", summary )
                        ]
                        |> Encode.encode 0
                        |> send
                        |> Task.perform (\() -> NoOp)
            in
            ( model, cmd )

        Complete testId labels expectations startTime endTime ->
            let
                result =
                    { labels = labels
                    , expectations = expectations
                    , duration = endTime - startTime
                    }

                newModel =
                    { model | completed = result :: model.completed }

                cmd =
                    case testReporter.reportComplete result of
                        Just val ->
                            Encode.object
                                [ ( "type", Encode.string "TEST_COMPLETED" )
                                , ( "format", Encode.string testReporter.format )
                                , ( "message", val )
                                ]
                                |> Encode.encode 0
                                |> send
                                |> Task.perform (\() -> NoOp)

                        Nothing ->
                            Cmd.none
            in
            ( newModel, cmd )

        Receive message ->
            let
                _ =
                    Debug.log "received message" message
            in
            case String.toInt message of
                Ok num ->
                    ( model, Task.perform (Dispatch num) Time.now )

                Err error ->
                    -- TODO send error to the process
                    ( model, Cmd.none )

        Dispatch testIndex startTime ->
            case model.queue of
                [] ->
                    ( model, Task.perform Finish Time.now )

                testId :: newQueue ->
                    case Dict.get testId model.available of
                        Nothing ->
                            ( model, Cmd.none )
                                |> warn ("Could not find testId " ++ toString testId)

                        Just { labels, run } ->
                            let
                                expectations =
                                    runThunk run

                                complete =
                                    Complete testId labels expectations startTime

                                available =
                                    Dict.remove testId model.available

                                newModel =
                                    { model
                                        | available = available
                                        , queue = newQueue
                                    }
                            in
                            ( newModel, Task.perform complete Time.now )


init :
    { initialSeed : Int
    , paths : List String
    , fuzzRuns : Int
    , startTime : Time
    , runners : SeededRunners
    , report : Report
    }
    -> ( Model, Cmd Msg )
init { startTime, paths, fuzzRuns, initialSeed, runners, report } =
    let
        _ =
            Debug.log "IT" "BEGINS"

        { indexedRunners, autoFail } =
            case runners of
                Plain runnerList ->
                    { indexedRunners = List.indexedMap (,) runnerList
                    , autoFail = Nothing
                    }

                Only runnerList ->
                    { indexedRunners = List.indexedMap (,) runnerList
                    , autoFail = Just "Test.only was used"
                    }

                Skipping runnerList ->
                    { indexedRunners = List.indexedMap (,) runnerList
                    , autoFail = Just "Test.skip was used"
                    }

                Invalid str ->
                    { indexedRunners = []
                    , autoFail = Just str
                    }

        testCount =
            List.length indexedRunners

        testReporter =
            createReporter report

        model =
            { available = Dict.fromList indexedRunners
            , running = Set.empty
            , queue = List.map Tuple.first indexedRunners
            , completed = []
            , startTime = startTime
            , finishTime = Nothing
            , testReporter = testReporter
            , autoFail = autoFail
            }

        _ =
            Debug.log "ABOUT TO SENT" ""
    in
    ( model, Task.perform (\() -> NoOp) (send "START") )


{-| Run the test using the provided options. If `Nothing` is provided for either
`runs` or `seed`, it will fall back on the options used in [`run`](#run).
-}
runWithOptions :
    App.RunnerOptions
    -> Test
    -> TestProgram
runWithOptions options =
    App.run options
        { init = init
        , update = update
        , subscriptions = \_ -> Debug.log "SUBZ" <| Sub.map Receive (messages Task.succeed)
        }
