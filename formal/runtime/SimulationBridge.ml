open Js_of_ocaml
module K = SimulationKernel
module J = Yojson.Basic.Util
let text key json = J.to_string (J.member key json)
let integer key json = Z.of_string (text key json)
let decode value = Yojson.Basic.from_string (Js.to_string value)
let encode value = Js.string (Yojson.Basic.to_string value)
let draft json : K.simulation_draft =
  { rounds_text = text "rounds" json; seed_text = text "seed" json;
    duration_text = text "duration" json; interval_text = text "interval" json }
let phase = function
  | "idle" -> K.Idle | "starting" -> K.Starting | "running" -> K.Running
  | "stopping" -> K.Stopping | "completed" -> K.Completed | "stopped" -> K.Stopped
  | "failed" -> K.Failed | _ -> invalid_arg "Unknown simulation job state"
let event json = match text "type" json with
  | "poll" -> K.Poll | "start" -> K.Begin | "stop" -> K.Halt
  | "edit" -> K.Edit (draft (J.member "draft" json))
  | "success" -> let data = J.member "data" json in
      let id = match J.member "id" data with `Null -> "" | value -> J.to_string value in
      K.Success (integer "requestId" json,
        { job_id = id; phase = phase (text "state" data); payload = Yojson.Basic.to_string data })
  | "failure" -> K.Failure (integer "requestId" json, text "error" json)
  | _ -> invalid_arg "Unknown simulation controller event"
let option_json f = function None -> `Null | Some x -> f x
let options (o : K.simulation_options) = `Assoc [
 "rounds", `Int (Z.to_int o.rounds); "seed", `Int (Z.to_int o.seed);
 "durationSeconds", `Int (Z.to_int o.duration); "intervalMs", `Int (Z.to_int o.interval) ]
let request (r : K.request) = `Assoc ( [ "requestId", `String (Z.to_string r.ticket) ] @
  match r.operation with
  | K.Read -> [ "kind", `String "read" ]
  | K.Start o -> [ "kind", `String "start"; "options", options o ]
  | K.Stop id -> [ "kind", `String "stop"; "jobId", `String id ])
let view (s : K.controller) = `Assoc [
 "data", option_json (fun (o : K.observation) -> Yojson.Basic.from_string o.payload) s.observed;
 "draft", `Assoc [ "rounds", `String s.draft.rounds_text; "seed", `String s.draft.seed_text;
   "duration", `String s.draft.duration_text; "interval", `String s.draft.interval_text ];
 "canStart", `Bool (K.can_start s); "canStop", `Bool (K.can_stop s);
 "canRefresh", `Bool (K.ready s); "active", `Bool (K.is_active s);
 "busy", `Bool (not (K.can_edit s));
 "invalidOptions", `Bool (Option.is_none (K.parse_options s.draft));
 "error", `String s.error; "uncertain", `Bool s.uncertain ]
let create () =
 let state = ref K.initial in
 Js.Unsafe.obj [| "view", Js.Unsafe.inject (Js.wrap_callback (fun () -> encode (view !state)));
 "dispatch", Js.Unsafe.inject (Js.wrap_callback (fun input ->
   let action = event (decode input) in
   let refresh = K.refresh_assets !state action in
   let next, effect = K.step !state action in
   state := next;
   encode (`Assoc [ "view", view next; "effect", option_json request effect; "refreshAssets", `Bool refresh ]))) |]
let () = Js.Unsafe.set Js.Unsafe.global "DEXSimulation"
 (Js.Unsafe.obj [| "create", Js.Unsafe.inject (Js.wrap_callback create) |])
