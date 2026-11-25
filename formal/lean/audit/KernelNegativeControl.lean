import Lean

/-!
Negative control for the kernel replay gate. The elaborator is told to skip kernel checking and
adds a "proof" of `1 = 2`; `leanchecker` must reject the resulting olean. Never import this.
-/

open Lean in
set_option debug.skipKernelTC true in
run_meta do
  let ty := mkApp3 (mkConst ``Eq [1]) (mkConst ``Nat) (mkNatLit 1) (mkNatLit 2)
  let val := mkApp2 (mkConst ``Eq.refl [1]) (mkConst ``Nat) (mkNatLit 1)
  addDecl (.thmDecl { name := `KernelNegativeControl.one_eq_two, levelParams := [], type := ty, value := val })
