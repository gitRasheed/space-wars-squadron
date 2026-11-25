import SpaceWars
import Lean

/-!
Prints one `AUDIT` line per constant defined in a `SpaceWars.*` module, with every axiom it
depends on, the same set `#print axioms` reports. `scripts/verify-lean.mjs` parses these lines.
-/

open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let mut rows : Array (String × String × Array Name) := #[]
  for (name, info) in env.constants.map₁.toList do
    let some idx := env.getModuleIdxFor? name | continue
    let some mod := env.header.moduleNames[idx.toNat]? | continue
    unless (`SpaceWars).isPrefixOf mod do continue
    let kind := match info with
      | .thmInfo _ => "theorem"
      | .axiomInfo _ => "axiom"
      | .opaqueInfo _ => "opaque"
      | .defnInfo _ => "def"
      | _ => "other"
    rows := rows.push (kind, name.toString, ← collectAxioms name)
  for (kind, name, axs) in rows.qsort (fun a b => a.2.1 < b.2.1) do
    IO.println s!"AUDIT {kind} {name} [{", ".intercalate (axs.toList.map toString)}]"
  IO.println s!"AUDIT-END {rows.size}"
