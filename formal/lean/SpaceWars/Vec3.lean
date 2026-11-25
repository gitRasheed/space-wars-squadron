/-!
Exact rational 3-vectors shared by the swept-hit and lead-intercept kernels. The game computes on
IEEE doubles; these proofs cover exact arithmetic, not float rounding.
-/

namespace SpaceWars

structure Vec3 where
  x : Rat
  y : Rat
  z : Rat

namespace Vec3

def zero : Vec3 := ⟨0, 0, 0⟩

def add (u v : Vec3) : Vec3 := ⟨u.x + v.x, u.y + v.y, u.z + v.z⟩

def sub (u v : Vec3) : Vec3 := ⟨u.x - v.x, u.y - v.y, u.z - v.z⟩

def smul (t : Rat) (v : Vec3) : Vec3 := ⟨t * v.x, t * v.y, t * v.z⟩

def dot (u v : Vec3) : Rat := u.x * v.x + u.y * v.y + u.z * v.z

def normSq (u : Vec3) : Rat := dot u u

/-- Position `d0 + t • dv` along a straight-line motion. -/
def along (d0 dv : Vec3) (t : Rat) : Vec3 := add d0 (smul t dv)

theorem mul_self_nonneg (a : Rat) : 0 ≤ a * a := by
  rcases Rat.nonneg_total a with h | h
  · exact Rat.mul_nonneg h h
  · have := Rat.mul_nonneg h h
    rw [Rat.neg_mul, Rat.mul_neg, Rat.neg_neg] at this
    exact this

theorem normSq_nonneg (u : Vec3) : 0 ≤ normSq u := by
  have := mul_self_nonneg u.x
  have := mul_self_nonneg u.y
  have := mul_self_nonneg u.z
  simp only [normSq, dot]
  grind

theorem eq_zero_of_mul_self_eq_zero {a : Rat} (h : a * a = 0) : a = 0 := by
  rcases Rat.nonneg_total a with h' | h'
  · grind
  · grind

/-- A vector with zero squared length is the zero vector. -/
theorem normSq_eq_zero {u : Vec3} (h : normSq u = 0) : u.x = 0 ∧ u.y = 0 ∧ u.z = 0 := by
  have hx := mul_self_nonneg u.x
  have hy := mul_self_nonneg u.y
  have hz := mul_self_nonneg u.z
  simp only [normSq, dot] at h
  refine ⟨eq_zero_of_mul_self_eq_zero ?_, eq_zero_of_mul_self_eq_zero ?_,
    eq_zero_of_mul_self_eq_zero ?_⟩ <;> grind

/-- Squared length along a line is the quadratic `|d0|² + 2t(d0·dv) + t²|dv|²`. -/
theorem normSq_along (d0 dv : Vec3) (t : Rat) :
    normSq (along d0 dv t) = normSq d0 + 2 * t * dot d0 dv + t * t * normSq dv := by
  simp only [normSq, dot, along, add, smul]
  grind

end Vec3
end SpaceWars
