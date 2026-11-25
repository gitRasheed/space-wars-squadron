import SpaceWars.SweptHit
import SpaceWars.LeadIntercept
import SpaceWars.HeatEconomy

/-!
# Negative controls

Each broken kernel below is checked against the same frozen spec the real kernel satisfies, and
each is shown to violate it with a concrete input.
-/

namespace SpaceWars.Counterexamples
open Vec3 SweptHit

/-! ## Swept hit -/

/-- Mutant: test only the end-of-tick position. -/
def endOfTickHit (d0 dv : Vec3) (r : Rat) : Bool := decide (normSq (rel d0 dv 1) ≤ r * r)

/-- Mutant: closest approach without clamping `t` to the tick. -/
def unclampedHit (d0 dv : Vec3) (r : Rat) : Bool :=
  decide (normSq (rel d0 dv (-(dot d0 dv) / normSq dv)) ≤ r * r)

/-- Mutant, as at HEAD in `combat.ts`: sweep the bolt against one fixed ship position, the
post-move one, ignoring how the ship moved during the tick. -/
def staticShipNearMiss (pb0 vb psEnd : Vec3) (rHit rGraze : Rat) : Bool :=
  nearMiss (sub pb0 psEnd) vb rHit rGraze

/-- A bolt crossing the centre at `t = 1/2` tunnels through an end-of-tick point test. -/
theorem end_of_tick_tunnels :
    endOfTickHit ⟨-2, 0, 0⟩ ⟨4, 0, 0⟩ 1 = false ∧
      normSq (rel ⟨-2, 0, 0⟩ ⟨4, 0, 0⟩ (1/2)) ≤ 1 * 1 ∧
      sweptHit ⟨-2, 0, 0⟩ ⟨4, 0, 0⟩ 1 = true := by
  refine ⟨?_, ?_, witness_hit⟩
  · unfold endOfTickHit
    exact decide_eq_false (by simp only [rel, along, normSq, dot, add, smul]; grind)
  · simp only [rel, along, normSq, dot, add, smul]; grind

theorem end_of_tick_incomplete : ¬ Complete endOfTickHit := by
  intro h
  have := h ⟨-2, 0, 0⟩ ⟨4, 0, 0⟩ 1 ⟨1/2, ⟨by grind, by grind⟩, end_of_tick_tunnels.2.1⟩
  rw [end_of_tick_tunnels.1] at this
  contradiction

/-- Moving away from a target 2 units off: the unclamped minimum lies at `t = -1/2`, before the
tick, so the mutant reports a hit although the bolt never comes within 2 units. -/
theorem unclamped_unsound : ¬ Sound unclampedHit := by
  intro h
  have hit : unclampedHit ⟨2, 0, 0⟩ ⟨4, 0, 0⟩ 1 = true := by
    unfold unclampedHit
    exact decide_eq_true (by simp only [rel, along, normSq, dot, add, smul]; grind)
  obtain ⟨t, ⟨ht0, _⟩, hin⟩ := h _ _ _ hit
  have := mul_self_nonneg t
  simp only [rel, along, normSq, dot, add, smul] at hin
  grind

/-- Astra's moving-ship bug, at unit scale: the bolt runs from `(-2, 2, 0)` to `(2, 2, 0)` while
the ship moves from the origin to `(0, 4, 0)`, and they meet at `t = 1/2`. Sweeping the bolt
against the ship's post-move position calls it a near miss. -/
theorem static_ship_misclassifies_hit :
    staticShipNearMiss ⟨-2, 2, 0⟩ ⟨4, 0, 0⟩ ⟨0, 4, 0⟩ 1 3 = true ∧
      sweptHit (sub ⟨-2, 2, 0⟩ ⟨0, 0, 0⟩) (sub ⟨4, 0, 0⟩ ⟨0, 4, 0⟩) 1 = true := by
  refine ⟨?_, sweptHit_complete _ _ _ ⟨1/2, ⟨by grind, by grind⟩, ?_⟩⟩
  · have hmin : missSq (sub ⟨-2, 2, 0⟩ ⟨0, 4, 0⟩) ⟨4, 0, 0⟩ = 4 := by
      simp only [missSq, tStar, clamp01, rel, along, normSq, dot, add, smul, sub]
      grind
    unfold staticShipNearMiss nearMiss
    rw [hmin]
    exact decide_eq_true (by grind)
  · simp only [rel, along, normSq, dot, add, smul, sub]; grind

/-- The static kernel breaks the disjointness theorem the relative kernel satisfies. -/
theorem static_ship_breaks_disjointness :
    ¬ ∀ pb0 vb ps0 vs rHit rGraze,
      (∃ t, InUnit t ∧ normSq (rel (sub pb0 ps0) (sub vb vs) t) ≤ rHit * rHit) →
        staticShipNearMiss pb0 vb (along ps0 vs 1) rHit rGraze = false := by
  intro h
  have hend : along ⟨0, 0, 0⟩ ⟨0, 4, 0⟩ 1 = (⟨0, 4, 0⟩ : Vec3) := by
    simp only [along, add, smul, Vec3.mk.injEq]; grind
  have := h ⟨-2, 2, 0⟩ ⟨4, 0, 0⟩ ⟨0, 0, 0⟩ ⟨0, 4, 0⟩ 1 3
    (sweptHit_sound _ _ _ static_ship_misclassifies_hit.2)
  rw [hend, static_ship_misclassifies_hit.1] at this
  contradiction

/-! ## Lead intercept -/

/-- Mutant: aim at the target's current position, flight time `‖d‖ / s`. A target 1 unit ahead
moving sideways at speed 1 is `√2` away after that flight, not 1. -/
theorem naive_aim_not_exact :
    normSq (LeadIntercept.leadPoint ⟨1, 0, 0⟩ ⟨0, 1, 0⟩ (1 / 1)) ≠ (1 * (1 / 1)) * (1 * (1 / 1)) := by
  simp only [LeadIntercept.leadPoint, along, normSq, dot, add, smul]; grind

/-! ## Heat economy -/

open HeatEconomy in
/-- Mutant: near-miss reward without the clamps. -/
def stepUnclamped (s : S) : Action → S
  | .nearMissHeatVent =>
    if s.overheated = false ∧ 0 < s.heat then { s with heat := s.heat - ventHeat }
    else { s with shield := s.shield + nearMissShield }
  | a => step s a

open HeatEconomy in
def runUnclamped (s : S) (acts : List Action) : S := acts.foldl stepUnclamped s

/-- The conclusion of `HeatEconomy.inv_bounds`. -/
def Bounded (s : HeatEconomy.S) : Prop :=
  0 ≤ s.heat ∧ s.heat ≤ 10000 ∧ 0 ≤ s.shield ∧ s.shield ≤ 10000

open HeatEconomy in
/-- One shot then an unclamped vent drives heat to -2.5%. -/
theorem unclamped_vent_negative_heat :
    (runUnclamped init [.fireShot, .nearMissHeatVent]).heat = -250 ∧
      ¬ Bounded (runUnclamped init [.fireShot, .nearMissHeatVent]) := by
  unfold Bounded; decide

open HeatEconomy in
/-- A near miss at full shields and zero heat overfills the shield to 106%. -/
theorem unclamped_shield_overflow :
    (runUnclamped init [.nearMissHeatVent]).shield = 10600 ∧
      ¬ Bounded (runUnclamped init [.nearMissHeatVent]) := by
  unfold Bounded; decide

open HeatEconomy in
/-- The mutant fails the trace property `trace_inv` and `inv_bounds` give the real step. -/
theorem unclamped_breaks_inv_bounds : ¬ ∀ acts, Bounded (runUnclamped init acts) :=
  fun h => unclamped_shield_overflow.2 (h _)

/-- The real step satisfies the same `Bounded` on every trace. -/
theorem real_step_bounded (acts : List HeatEconomy.Action) :
    Bounded (HeatEconomy.run HeatEconomy.init acts) :=
  HeatEconomy.inv_bounds (HeatEconomy.reachable_run .init acts)

end SpaceWars.Counterexamples
