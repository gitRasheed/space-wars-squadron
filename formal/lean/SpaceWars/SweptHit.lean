import SpaceWars.Vec3

/-!
# Relative-motion swept segment-vs-sphere test

Over one tick the bolt moves `pb(t) = pb0 + t • vb` and the ship moves `ps(t) = ps0 + t • vs`,
`t ∈ [0, 1]`. Their offset is `rel(t) = d0 + t • dv` with `d0 = pb0 - ps0`, `dv = vb - vs`.
The kernel evaluates `|rel|²` once, at the clamped closest-approach time `tStar`, and these
theorems show that one evaluation decides the whole tick: no instant can be inside the sphere
without the test reporting a hit, and a near miss can never be a trajectory that touched the hit
sphere.
-/

namespace SpaceWars.SweptHit
open Vec3

def InUnit (t : Rat) : Prop := 0 ≤ t ∧ t ≤ 1

def clamp01 (x : Rat) : Rat := if x < 0 then 0 else if 1 < x then 1 else x

/-- Relative offset bolt-minus-ship at fraction `t` of the tick. -/
def rel (d0 dv : Vec3) (t : Rat) : Vec3 := along d0 dv t

/-- Clamped closest-approach time; zero relative velocity means the offset never changes. -/
def tStar (d0 dv : Vec3) : Rat :=
  if normSq dv = 0 then 0 else clamp01 (-(dot d0 dv) / normSq dv)

/-- Squared miss distance at closest approach within the tick. -/
def missSq (d0 dv : Vec3) : Rat := normSq (rel d0 dv (tStar d0 dv))

def sweptHit (d0 dv : Vec3) (r : Rat) : Bool := decide (missSq d0 dv ≤ r * r)

def nearMiss (d0 dv : Vec3) (rHit rGraze : Rat) : Bool :=
  decide (rHit * rHit < missSq d0 dv ∧ missSq d0 dv ≤ rGraze * rGraze)

/-- Frozen spec: any instant inside the sphere during the tick must register. -/
def Complete (hit : Vec3 → Vec3 → Rat → Bool) : Prop :=
  ∀ d0 dv r, (∃ t, InUnit t ∧ normSq (rel d0 dv t) ≤ r * r) → hit d0 dv r = true

/-- Frozen spec: a hit must be backed by an instant inside the sphere during the tick. -/
def Sound (hit : Vec3 → Vec3 → Rat → Bool) : Prop :=
  ∀ d0 dv r, hit d0 dv r = true → ∃ t, InUnit t ∧ normSq (rel d0 dv t) ≤ r * r

/-- `rel` is exactly the bolt position minus the ship position when both move during the tick. -/
theorem rel_is_relative_motion (pb0 vb ps0 vs : Vec3) (t : Rat) :
    rel (sub pb0 ps0) (sub vb vs) t = sub (along pb0 vb t) (along ps0 vs t) := by
  simp only [rel, along, add, sub, smul, Vec3.mk.injEq]
  grind

theorem clamp01_mem (x : Rat) : InUnit (clamp01 x) := by
  unfold clamp01 InUnit
  grind

theorem tStar_mem (d0 dv : Vec3) : InUnit (tStar d0 dv) := by
  unfold tStar
  split
  · exact ⟨by grind, by grind⟩
  · exact clamp01_mem _

/-- `f(t) - f(s)` for the quadratic `f(t) = c + 2bt + at²`. -/
private theorem quad_diff (a b c t s : Rat) :
    (c + 2 * t * b + t * t * a) - (c + 2 * s * b + s * s * a) = (t - s) * (2 * b + a * (t + s)) := by
  grind

/-- Global minimum: no instant in the tick comes closer than `tStar`. -/
theorem closest_approach_global_min (d0 dv : Vec3) (t : Rat) (ht : InUnit t) :
    missSq d0 dv ≤ normSq (rel d0 dv t) := by
  obtain ⟨ht0, ht1⟩ := ht
  unfold missSq rel
  rw [normSq_along, normSq_along]
  have ha0 := normSq_nonneg dv
  unfold tStar
  by_cases ha : normSq dv = 0
  · -- zero relative velocity: `dv = 0`, so the offset is constant
    have hz := normSq_eq_zero ha
    have hb : dot d0 dv = 0 := by simp only [dot]; rw [hz.1, hz.2.1, hz.2.2]; grind
    simp only [ha, hb, ↓reduceIte]
    grind
  · simp only [ha, ↓reduceIte]
    have hapos : 0 < normSq dv := by grind
    generalize hu : -dot d0 dv / normSq dv = u
    have hau : normSq dv * u = -dot d0 dv := by
      rw [← hu]; grind
    unfold clamp01
    by_cases hu0 : u < 0
    · simp only [hu0, ↓reduceIte]
      have hq := quad_diff (normSq dv) (dot d0 dv) (normSq d0) t 0
      have hneg : 0 < normSq dv * (-u) := Rat.mul_pos hapos (by grind)
      have hat : 0 ≤ normSq dv * t := Rat.mul_nonneg ha0 ht0
      have hprod : 0 ≤ t * (2 * dot d0 dv + normSq dv * t) := Rat.mul_nonneg ht0 (by grind)
      grind
    · simp only [hu0, ↓reduceIte]
      by_cases hu1 : 1 < u
      · simp only [hu1, ↓reduceIte]
        have hq := quad_diff (normSq dv) (dot d0 dv) (normSq d0) t 1
        have hbig : 0 < normSq dv * (u - 1) := Rat.mul_pos hapos (by grind)
        have hat : 0 ≤ normSq dv * (1 - t) := Rat.mul_nonneg ha0 (by grind)
        have hprod : 0 ≤ (1 - t) * (-(2 * dot d0 dv + normSq dv * (t + 1))) :=
          Rat.mul_nonneg (by grind) (by grind)
        grind
      · simp only [hu1, ↓reduceIte]
        have hq := quad_diff (normSq dv) (dot d0 dv) (normSq d0) t u
        have hsq : 0 ≤ normSq dv * ((t - u) * (t - u)) := Rat.mul_nonneg ha0 (mul_self_nonneg _)
        have hb : dot d0 dv = -(normSq dv * u) := by grind
        rw [hb] at hq ⊢
        grind

/-- Zero tunneling: entering the sphere at any instant of the tick registers a hit. -/
theorem sweptHit_complete : Complete sweptHit := by
  intro d0 dv r ⟨t, ht, hin⟩
  have := closest_approach_global_min d0 dv t ht
  unfold sweptHit
  exact decide_eq_true (by grind)

/-- Every reported hit has a real instant inside the sphere during the tick. -/
theorem sweptHit_sound : Sound sweptHit := by
  intro d0 dv r h
  exact ⟨tStar d0 dv, tStar_mem d0 dv, of_decide_eq_true h⟩

theorem sweptHit_iff (d0 dv : Vec3) (r : Rat) :
    sweptHit d0 dv r = true ↔ ∃ t, InUnit t ∧ normSq (rel d0 dv t) ≤ r * r :=
  ⟨sweptHit_sound d0 dv r, sweptHit_complete d0 dv r⟩

/-- A trajectory that entered the hit sphere at any instant is never classified a near miss. -/
theorem entered_hit_sphere_not_nearMiss (d0 dv : Vec3) (rHit rGraze : Rat)
    (h : ∃ t, InUnit t ∧ normSq (rel d0 dv t) ≤ rHit * rHit) :
    nearMiss d0 dv rHit rGraze = false := by
  obtain ⟨t, ht, hin⟩ := h
  have := closest_approach_global_min d0 dv t ht
  unfold nearMiss
  exact decide_eq_false (by grind)

/-- A trajectory strictly outside the hit sphere for the whole tick never registers a hit. -/
theorem outside_hit_sphere_no_hit (d0 dv : Vec3) (rHit : Rat)
    (h : ∀ t, InUnit t → rHit * rHit < normSq (rel d0 dv t)) :
    sweptHit d0 dv rHit = false := by
  have := h (tStar d0 dv) (tStar_mem d0 dv)
  unfold sweptHit missSq
  exact decide_eq_false (by grind)

theorem hit_nearMiss_disjoint (d0 dv : Vec3) (rHit rGraze : Rat) :
    ¬ (sweptHit d0 dv rHit = true ∧ nearMiss d0 dv rHit rGraze = true) := by
  intro ⟨h1, h2⟩
  have := of_decide_eq_true h1
  have := of_decide_eq_true h2
  grind

/-- A near miss means the bolt came within the graze radius at some instant but never touched
the hit sphere. -/
theorem nearMiss_sound (d0 dv : Vec3) (rHit rGraze : Rat)
    (h : nearMiss d0 dv rHit rGraze = true) :
    (∃ t, InUnit t ∧ normSq (rel d0 dv t) ≤ rGraze * rGraze) ∧
      ∀ t, InUnit t → rHit * rHit < normSq (rel d0 dv t) := by
  have hm := of_decide_eq_true h
  refine ⟨⟨tStar d0 dv, tStar_mem d0 dv, hm.2⟩, fun t ht => ?_⟩
  have := closest_approach_global_min d0 dv t ht
  grind

/-! Non-vacuity: both outcomes the theorems talk about actually occur. -/

/-- Head-on pass through the centre at mid-tick: a hit. -/
theorem witness_hit : sweptHit ⟨-2, 0, 0⟩ ⟨4, 0, 0⟩ 1 = true :=
  sweptHit_complete _ _ _ ⟨1/2, ⟨by grind, by grind⟩, by simp only [rel, along, normSq, dot, add, smul]; grind⟩

/-- Passing two units off-centre: a near miss for hit radius 1 and graze radius 3. -/
theorem witness_nearMiss : nearMiss ⟨-2, 2, 0⟩ ⟨4, 0, 0⟩ 1 3 = true := by
  have hmin : missSq ⟨-2, 2, 0⟩ ⟨4, 0, 0⟩ = 4 := by
    simp only [missSq, tStar, clamp01, rel, along, normSq, dot, add, smul]
    grind
  unfold nearMiss
  rw [hmin]
  exact decide_eq_true (by grind)

end SpaceWars.SweptHit
