import SpaceWars.Vec3

/-!
# Ballistic lead intercept

`solveInterceptTime` in `src/sim/math.ts` takes the target offset `d` and relative velocity `v`
and solves `a t² + b t + c = 0` with `a = |v|² - s²`, `b = 2 d·v`, `c = |d|²` for the bolt speed
`s`. `computeLeadPoint` then aims at `d + t • v`. These theorems show any root it returns puts the
target exactly one bolt flight `s t` away from the muzzle at time `t`, so a bolt fired at the lead
point arrives together with the target.
-/

namespace SpaceWars.LeadIntercept
open Vec3

def coefA (v : Vec3) (s : Rat) : Rat := normSq v - s * s
def coefB (d v : Vec3) : Rat := 2 * dot d v
def coefC (d : Vec3) : Rat := normSq d

def quad (d v : Vec3) (s t : Rat) : Rat := coefA v s * t * t + coefB d v * t + coefC d

/-- Target offset at time `t`, which is where the lead point is placed. -/
def leadPoint (d v : Vec3) (t : Rat) : Vec3 := along d v t

theorem normSq_leadPoint_eq (d v : Vec3) (s t : Rat) :
    normSq (leadPoint d v t) = quad d v s t + (s * t) * (s * t) := by
  unfold leadPoint quad coefA coefB coefC
  rw [normSq_along]
  grind

/-- Intercept exactness: any root of the quadratic is a time at which the target sits exactly
`s t` from the muzzle. -/
theorem intercept_exact (d v : Vec3) (s t : Rat) (h : quad d v s t = 0) :
    normSq (leadPoint d v t) = (s * t) * (s * t) := by
  rw [normSq_leadPoint_eq d v s t, h]
  grind

/-- The converse: if the target is exactly `s t` away at time `t`, then `t` is a root. -/
theorem intercept_root_of_exact (d v : Vec3) (s t : Rat)
    (h : normSq (leadPoint d v t) = (s * t) * (s * t)) : quad d v s t = 0 := by
  rw [normSq_leadPoint_eq d v s t] at h
  grind

/-- Quadratic-formula roots, as `solveInterceptTime` computes them, satisfy the quadratic.
`D` stands for `√disc`, given as any `D` with `D² = b² - 4ac`. -/
theorem quadratic_root_exact (d v : Vec3) (s D : Rat) (ha : coefA v s ≠ 0)
    (hD : D * D = coefB d v * coefB d v - 4 * coefA v s * coefC d) :
    let tPlus := (-coefB d v + D) / (2 * coefA v s)
    let tMinus := (-coefB d v - D) / (2 * coefA v s)
    normSq (leadPoint d v tPlus) = (s * tPlus) * (s * tPlus) ∧
      normSq (leadPoint d v tMinus) = (s * tMinus) * (s * tMinus) := by
  intro tPlus tMinus
  have h2a : 2 * coefA v s ≠ 0 := by grind
  refine ⟨intercept_exact d v s tPlus ?_, intercept_exact d v s tMinus ?_⟩
  · have hm : (2 * coefA v s) * tPlus = -coefB d v + D := by
      simp only [tPlus]; grind
    unfold quad
    have key : (2 * coefA v s) * (2 * coefA v s) *
        (coefA v s * tPlus * tPlus + coefB d v * tPlus + coefC d) = 0 := by
      have : (2 * coefA v s) * (2 * coefA v s) *
          (coefA v s * tPlus * tPlus + coefB d v * tPlus + coefC d) =
          coefA v s * (((2 * coefA v s) * tPlus) * ((2 * coefA v s) * tPlus)) +
            2 * coefA v s * coefB d v * ((2 * coefA v s) * tPlus) +
            4 * coefA v s * coefA v s * coefC d := by grind
      rw [this, hm]
      grind
    have h4 : (2 * coefA v s) * (2 * coefA v s) ≠ 0 := by grind
    grind
  · have hm : (2 * coefA v s) * tMinus = -coefB d v - D := by
      simp only [tMinus]; grind
    unfold quad
    have key : (2 * coefA v s) * (2 * coefA v s) *
        (coefA v s * tMinus * tMinus + coefB d v * tMinus + coefC d) = 0 := by
      have : (2 * coefA v s) * (2 * coefA v s) *
          (coefA v s * tMinus * tMinus + coefB d v * tMinus + coefC d) =
          coefA v s * (((2 * coefA v s) * tMinus) * ((2 * coefA v s) * tMinus)) +
            2 * coefA v s * coefB d v * ((2 * coefA v s) * tMinus) +
            4 * coefA v s * coefA v s * coefC d := by grind
      rw [this, hm]
      grind
    have h4 : (2 * coefA v s) * (2 * coefA v s) ≠ 0 := by grind
    grind

/-- Closing at the target means it is not at the muzzle, so `c > 0`. -/
theorem coefC_pos_of_closing (d v : Vec3) (hb : coefB d v < 0) : 0 < coefC d := by
  have hc := normSq_nonneg d
  unfold coefC at *
  rcases Rat.le_iff_lt_or_eq.mp hc with h | h
  · exact h
  · have hz := normSq_eq_zero h.symm
    unfold coefB dot at hb
    rw [hz.1, hz.2.1, hz.2.2] at hb
    grind

/-- Equal bolt and target speed (`a = 0`): the root `t = -c / b` of a closing shot is a strictly
positive, exact intercept. -/
theorem linear_case_exact (d v : Vec3) (s : Rat) (ha : coefA v s = 0) (hb : coefB d v < 0) :
    let t := -coefC d / coefB d v
    0 < t ∧ normSq (leadPoint d v t) = (s * t) * (s * t) := by
  intro t
  have hc := coefC_pos_of_closing d v hb
  have hbt : coefB d v * t = -coefC d := by simp only [t]; grind
  refine ⟨?_, intercept_exact d v s t ?_⟩
  · -- `b < 0` and `b t = -c < 0` force `t > 0`
    rcases Rat.nonneg_total t with ht | ht
    · rcases Rat.le_iff_lt_or_eq.mp ht with ht' | ht'
      · exact ht'
      · rw [← ht'] at hbt; grind
    · have := Rat.mul_nonneg (Rat.le_of_lt (by grind : 0 < -coefB d v)) ht
      grind
  · unfold quad; rw [ha]; grind

/-- Stationary relative target (`v = 0`): flying `‖d‖ / s` is exact. `ℓ` stands for `‖d‖`, given
as any `ℓ ≥ 0` with `ℓ² = |d|²`. -/
theorem zero_velocity_exact (d : Vec3) (s ℓ : Rat) (hs : 0 < s) (hℓ : 0 ≤ ℓ)
    (hℓsq : ℓ * ℓ = normSq d) :
    let t := ℓ / s
    0 ≤ t ∧ quad d Vec3.zero s t = 0 ∧
      normSq (leadPoint d Vec3.zero t) = (s * t) * (s * t) := by
  intro t
  have hst : s * t = ℓ := by simp only [t]; grind
  have hq : quad d Vec3.zero s t = 0 := by
    unfold quad coefA coefB coefC
    simp only [normSq, dot, Vec3.zero] at *
    have : s * t * (s * t) = ℓ * ℓ := by rw [hst]
    grind
  refine ⟨?_, hq, intercept_exact _ _ _ _ hq⟩
  have hinv : 0 ≤ s⁻¹ := Rat.le_of_lt (Rat.inv_pos.mpr hs)
  have := Rat.mul_nonneg hℓ hinv
  simp only [t]
  grind

/-! Non-vacuity: each case has an instance. -/

/-- A target 3 units away receding sideways at speed 4, bolt speed 5: `t = 1`. -/
theorem witness_quadratic : quad ⟨3, 0, 0⟩ ⟨0, 4, 0⟩ 5 1 = 0 := by
  simp only [quad, coefA, coefB, coefC, normSq, dot]; grind

/-- Head-on closing at equal speed: `a = 0`, `b < 0`. -/
theorem witness_linear : coefA ⟨-1, 0, 0⟩ 1 = 0 ∧ coefB ⟨4, 0, 0⟩ ⟨-1, 0, 0⟩ < 0 := by
  simp only [coefA, coefB, normSq, dot]; grind

end SpaceWars.LeadIntercept
