/-!
# Weapon heat, overheat lockout, overdrive and shield economy

Integer model of `src/sim/energy.ts` and the near-miss and supply-drop rewards in
`src/sim/combat.ts`, one action per 60 Hz tick. Units are hundredths of a percent, so `10000` is
100%. Heat is `100 - weaponCharge` from the game code.

| constant           | value | source                                                |
|--------------------|-------|-------------------------------------------------------|
| `shotHeat`         |   950 | `ENERGY_RULES.primaryShotCost` 9.5                    |
| `coolRate`         |    40 | `weaponRechargePerSecond` 24 / 60                     |
| `overheatCoolRate` |    25 | `overheatCooldownPerSecond` 15 / 60                   |
| `minOverdrive`     |  1500 | `minOverdriveShield` 15                               |
| `overdriveDrain`   |    40 | `overdriveShieldDrainPerSecond` 24 / 60               |
| `ventHeat`         |  1200 | `COMBAT_TUNING.nearMissHeatVent` 12                   |
| `nearMissShield`   |   600 | `COMBAT_TUNING.nearMissShieldRestore` 6               |
| `surgeShield`      |  2500 | `COMBAT_TUNING.shieldSurge` 25                        |
| `rechargeRate`     |    25 | not in `src/sim` yet: manual recharge is spec-only    |

The hot zone (80-100%) and manual shield recharge do not exist in `src/sim` at the time of
writing; they model the planned mechanic. Passive shield regen is left out, since it only raises
the shield under the same clamp as `ManualRechargeTick`.
-/

namespace SpaceWars.HeatEconomy

def heatMax : Int := 10000
def shieldMax : Int := 10000
def hotZoneMin : Int := 8000
def shotHeat : Int := 950
def coolRate : Int := 40
def overheatCoolRate : Int := 25
def minOverdrive : Int := 1500
def overdriveDrain : Int := 40
def ventHeat : Int := 1200
def nearMissShield : Int := 600
def surgeShield : Int := 2500
def rechargeRate : Int := 25

@[simp] theorem heatMax_eq : heatMax = 10000 := rfl
@[simp] theorem shieldMax_eq : shieldMax = 10000 := rfl
@[simp] theorem hotZoneMin_eq : hotZoneMin = 8000 := rfl
@[simp] theorem shotHeat_eq : shotHeat = 950 := rfl
@[simp] theorem coolRate_eq : coolRate = 40 := rfl
@[simp] theorem overheatCoolRate_eq : overheatCoolRate = 25 := rfl
@[simp] theorem minOverdrive_eq : minOverdrive = 1500 := rfl
@[simp] theorem overdriveDrain_eq : overdriveDrain = 40 := rfl
@[simp] theorem ventHeat_eq : ventHeat = 1200 := rfl
@[simp] theorem nearMissShield_eq : nearMissShield = 600 := rfl
@[simp] theorem surgeShield_eq : surgeShield = 2500 := rfl
@[simp] theorem rechargeRate_eq : rechargeRate = 25 := rfl

structure S where
  heat : Int
  shield : Int
  overheated : Bool
  overdrive : Bool
  recharging : Bool
  deriving DecidableEq, Repr

inductive Drop where
  | heatFlush
  | shieldSurge
  deriving DecidableEq, Repr

inductive Action where
  | fireShot
  | coolTick
  | overheatTick
  | startOverdrive
  | overdriveTick
  | manualRechargeTick
  | applyDamage (dmg : Nat)
  | nearMissHeatVent
  | supplyDrop (drop : Drop)
  deriving DecidableEq, Repr

def init : S := ⟨0, shieldMax, false, false, false⟩

def step (s : S) : Action → S
  | .fireShot =>
    if s.overheated then s
    else if heatMax ≤ s.heat + shotHeat then { s with heat := heatMax, overheated := true }
    else { s with heat := s.heat + shotHeat }
  | .coolTick =>
    if s.overheated then s else { s with heat := max 0 (s.heat - coolRate) }
  | .overheatTick =>
    if s.overheated then
      { s with heat := max 0 (s.heat - overheatCoolRate),
               overheated := decide (0 < s.heat - overheatCoolRate) }
    else s
  | .startOverdrive =>
    if s.overdrive = false ∧ minOverdrive ≤ s.shield then
      { s with overdrive := true, recharging := false }
    else s
  | .overdriveTick =>
    if s.overdrive then
      { s with shield := max 0 (s.shield - overdriveDrain),
               overdrive := decide (0 < s.shield - overdriveDrain) }
    else s
  | .manualRechargeTick =>
    if s.overdrive then s
    else
      { s with shield := min shieldMax (s.shield + rechargeRate),
               recharging := decide (s.shield + rechargeRate < shieldMax) }
  | .applyDamage dmg =>
    { s with shield := max 0 (s.shield - dmg),
             overdrive := s.overdrive && decide (0 < s.shield - dmg) }
  | .nearMissHeatVent =>
    if s.overheated = false ∧ 0 < s.heat then { s with heat := max 0 (s.heat - ventHeat) }
    else { s with shield := min shieldMax (s.shield + nearMissShield) }
  | .supplyDrop .heatFlush => { s with heat := 0, overheated := false }
  | .supplyDrop .shieldSurge => { s with shield := min shieldMax (s.shield + surgeShield) }

def run (s : S) (acts : List Action) : S := acts.foldl step s

inductive Reachable : S → Prop where
  | init : Reachable init
  | step {s : S} (a : Action) : Reachable s → Reachable (step s a)

def inHotZone (s : S) : Prop := hotZoneMin ≤ s.heat ∧ s.overheated = false

/-- Inductive invariant: bounds, the lockout tracks full heat, and the shield modes exclude. -/
def Inv (s : S) : Prop :=
  0 ≤ s.heat ∧ s.heat ≤ heatMax ∧ 0 ≤ s.shield ∧ s.shield ≤ shieldMax ∧
  (s.overheated = true → 0 < s.heat) ∧
  (heatMax ≤ s.heat → s.overheated = true) ∧
  ¬ (s.recharging = true ∧ s.overdrive = true) ∧
  (s.overdrive = true → 0 < s.shield)

theorem inv_init : Inv init := by simp [Inv, init]

theorem inv_step (s : S) (a : Action) (h : Inv s) : Inv (step s a) := by
  obtain ⟨heat, shield, oh, od, rc⟩ := s
  unfold Inv at h ⊢
  cases a with
  | supplyDrop d => cases d <;> cases oh <;> simp_all [step] <;> omega
  | applyDamage dmg => cases od <;> simp_all [step] <;> omega
  | _ => simp only [step] <;> (repeat' split) <;> simp_all <;> omega

theorem reachable_inv {s : S} (h : Reachable s) : Inv s := by
  induction h with
  | init => exact inv_init
  | step a _ ih => exact inv_step _ a ih

theorem reachable_run {s : S} (h : Reachable s) (acts : List Action) : Reachable (run s acts) := by
  induction acts generalizing s with
  | nil => exact h
  | cons a rest ih => exact ih (Reachable.step a h)

/-- Unbounded traces: the invariant holds after every finite action sequence from `init`. -/
theorem trace_inv (acts : List Action) : Inv (run init acts) :=
  reachable_inv (reachable_run Reachable.init acts)

theorem inv_bounds {s : S} (h : Reachable s) :
    0 ≤ s.heat ∧ s.heat ≤ 10000 ∧ 0 ≤ s.shield ∧ s.shield ≤ 10000 := by
  have := reachable_inv h
  simp only [Inv, heatMax_eq, shieldMax_eq] at this
  omega

/-- Holds by definition: `inHotZone` already requires `overheated = false`. Kept because the
spec asks for it; `inv_full_heat_locks` and `hot_zone_fire_stays_hot` carry the content. -/
theorem inv_hot_zone_disjoint (s : S) (h : inHotZone s) : s.overheated = false := h.2

/-- Reaching 100% heat always means the lockout is on. -/
theorem inv_full_heat_locks {s : S} (h : Reachable s) (hfull : 10000 ≤ s.heat) :
    s.overheated = true := (reachable_inv h).2.2.2.2.2.1 hfull

/-- An unlocked gun is always below 100% heat. -/
theorem unlocked_below_max {s : S} (h : Reachable s) (hu : s.overheated = false) :
    s.heat < 10000 := by
  have := reachable_inv h
  simp only [Inv, heatMax_eq] at this
  rcases this with ⟨_, _, _, _, _, hl, _⟩
  by_cases hh : 10000 ≤ s.heat
  · rw [hl hh] at hu; contradiction
  · omega

/-- The lockout is entered only by a shot that pushes heat to 100%. -/
theorem overheat_entered_only_by_full_shot {s : S} (a : Action) (hu : s.overheated = false)
    (ho : (step s a).overheated = true) :
    a = .fireShot ∧ heatMax ≤ s.heat + shotHeat ∧ (step s a).heat = heatMax := by
  cases a with
  | supplyDrop d => cases d <;> simp_all [step]
  | fireShot =>
    simp only [step, hu, Bool.false_eq_true, ↓reduceIte] at ho ⊢
    by_cases hf : heatMax ≤ s.heat + shotHeat
    · simp only [hf, ↓reduceIte, and_self]
    · simp only [hf, ↓reduceIte] at ho
      exact absurd ho (by decide)
  | _ => simp_all [step] <;> (try split at ho) <;> simp_all

/-- Firing is impossible while overheated: the shot is refused and nothing changes. -/
theorem inv_overheat_no_fire (s : S) (h : s.overheated = true) : step s .fireShot = s := by
  simp [step, h]

/-- Without the lockout every shot adds heat. -/
theorem fire_adds_heat {s : S} (h : Reachable s) (hu : s.overheated = false) :
    s.heat < (step s .fireShot).heat := by
  have := unlocked_below_max h hu
  simp only [step, hu, Bool.false_eq_true, ↓reduceIte]
  split <;> simp_all <;> omega

/-- A shot from the hot zone either stays in the hot zone or trips the lockout at 100%. -/
theorem hot_zone_fire_stays_hot {s : S} (h : Reachable s) (hz : inHotZone s) :
    inHotZone (step s .fireShot) ∨
      ((step s .fireShot).overheated = true ∧ (step s .fireShot).heat = heatMax) := by
  have := unlocked_below_max h hz.2
  obtain ⟨hmin, hu⟩ := hz
  unfold inHotZone
  simp only [step, hu, Bool.false_eq_true, ↓reduceIte]
  split <;> simp_all <;> omega

theorem inv_mutual_exclusion {s : S} (h : Reachable s) :
    ¬ (s.recharging = true ∧ s.overdrive = true) ∧ (s.overdrive = true → 0 < s.shield) :=
  (reachable_inv h).2.2.2.2.2.2

/-! ## Overheat termination -/

def ticks : Nat → S → S
  | 0, s => s
  | k + 1, s => ticks k (step s .overheatTick)

/-- `⌈heatMax / overheatCoolRate⌉`. -/
def overheatTickBound : Int := (heatMax + overheatCoolRate - 1) / overheatCoolRate

theorem overheatTickBound_eq : overheatTickBound = 400 := by decide

theorem ticks_unlocked (k : Nat) (s : S) (hu : s.overheated = false) : ticks k s = s := by
  induction k with
  | zero => rfl
  | succ k ih => simp [ticks, step, hu, ih]

/-- Locked with `heat ≤ 25 k`: `k` lockout ticks unlock the gun at zero heat. -/
theorem ticks_unlock (k : Nat) (s : S) (ho : s.overheated = true) (hpos : 0 < s.heat)
    (hk : s.heat ≤ overheatCoolRate * k) :
    (ticks k s).overheated = false ∧ (ticks k s).heat = 0 := by
  induction k generalizing s with
  | zero => simp at hk; omega
  | succ k ih =>
    simp only [ticks]
    simp only [overheatCoolRate_eq] at hk ⊢
    by_cases hlast : s.heat - 25 ≤ 0
    · have hu : (step s .overheatTick).overheated = false := by
        simp [step, ho]; omega
      rw [ticks_unlocked k _ hu]
      simp [step, ho]; omega
    · apply ih
      · simp [step, ho]; omega
      · simp [step, ho]; omega
      · simp [step, ho] at hk ⊢; omega

/-- Locked with `heat > 25 k`: after `k` lockout ticks the gun is still locked. -/
theorem ticks_still_locked (k : Nat) (s : S) (ho : s.overheated = true)
    (hk : overheatCoolRate * k < s.heat) :
    (ticks k s).overheated = true ∧ (ticks k s).heat = s.heat - overheatCoolRate * k := by
  induction k generalizing s with
  | zero => simp [ticks]; exact ho
  | succ k ih =>
    simp only [ticks]
    simp only [overheatCoolRate_eq] at hk ⊢
    have hstep : (step s .overheatTick).overheated = true := by
      simp [step, ho] at hk ⊢; omega
    have := ih (step s .overheatTick) hstep (by simp [step, ho] at hk ⊢; omega)
    refine ⟨this.1, ?_⟩
    rw [this.2]
    simp [step, ho] at hk ⊢
    omega

/-- From any overheated state with heat at most 100%, reachable or not, the lockout ends at zero
heat within `⌈heatMax / 25⌉ = 400` lockout ticks, and every earlier tick is still locked. With
positive heat it takes exactly `⌈heat / 25⌉` ticks. -/
theorem overheat_terminates_of_le_max (s : S) (ho : s.overheated = true) (hle : s.heat ≤ heatMax) :
    ∃ k : Nat, (k : Int) ≤ overheatTickBound ∧
      (ticks k s).overheated = false ∧ (ticks k s).heat = 0 ∧
      ∀ j < k, (ticks j s).overheated = true := by
  rw [heatMax_eq] at hle
  by_cases hpos : 0 < s.heat
  · refine ⟨((s.heat + 24) / 25).toNat, ?_, ?_, ?_, ?_⟩
    · rw [overheatTickBound_eq]; omega
    · exact (ticks_unlock _ s ho hpos (by rw [overheatCoolRate_eq]; omega)).1
    · exact (ticks_unlock _ s ho hpos (by rw [overheatCoolRate_eq]; omega)).2
    · intro j hj
      exact (ticks_still_locked j s ho (by rw [overheatCoolRate_eq]; omega)).1
  · refine ⟨1, by rw [overheatTickBound_eq]; omega, ?_, ?_, ?_⟩
    · simp [ticks, step, ho]; omega
    · simp [ticks, step, ho]; omega
    · intro j hj
      have : j = 0 := by omega
      subst this
      exact ho

/-- The same bound for every overheated state reachable from `init`. -/
theorem overheat_terminates {s : S} (h : Reachable s) (ho : s.overheated = true) :
    ∃ k : Nat, (k : Int) ≤ overheatTickBound ∧
      (ticks k s).overheated = false ∧ (ticks k s).heat = 0 ∧
      ∀ j < k, (ticks j s).overheated = true :=
  overheat_terminates_of_le_max s ho (reachable_inv h).2.1

/-! Non-vacuity: every mode the theorems talk about is reachable from `init`. -/

theorem witness_hot_zone : inHotZone (run init (List.replicate 9 .fireShot)) := by
  unfold inHotZone; decide

theorem witness_overheat : (run init (List.replicate 11 .fireShot)).overheated = true := by decide

theorem witness_overdrive : (run init [.startOverdrive]).overdrive = true := by decide

theorem witness_recharging :
    (run init [.applyDamage 3000, .manualRechargeTick]).recharging = true := by decide

end SpaceWars.HeatEconomy
