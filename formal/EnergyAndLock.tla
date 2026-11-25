----------------------------- MODULE EnergyAndLock -----------------------------
EXTENDS Integers, Sequences

VARIABLES projection, primaryCooldown, overdrive, weaponState, weaponCharge, overheatTicks, shieldCharge,
          shieldDelay, missilesReady, targetAlive, lockTicks, rearmTicks, rearmPeriod, missileCooldown, launchStock

flight == <<primaryCooldown, overdrive, weaponState, weaponCharge, overheatTicks, shieldCharge, shieldDelay>>
combat == <<missilesReady, targetAlive, lockTicks, rearmTicks, rearmPeriod, missileCooldown, launchStock>>
vars == <<projection, flight, combat>>

(* With geometry supplied as input, each property depends on just one of
   these two state machines. Explore each projection from the initial ship. *)
MaxMissiles == 4
AcquireTicks == 48
FreshRearm == 720
CarriedRearm == 720
MissileCooldown == 34
PrimaryCooldown == 9
ShieldRegenDelayTicks == 211
OverheatTicks == 400
LockState == CASE lockTicks = 0 -> "none" [] lockTicks = AcquireTicks -> "locked" [] OTHER -> "acquiring"

Init ==
    /\ projection \in {"flight", "combat"}
    /\ primaryCooldown = 0
    /\ overdrive = FALSE
    /\ weaponState = "ready"
    /\ weaponCharge = 2
    /\ overheatTicks = 0
    /\ shieldCharge = 3
    /\ shieldDelay = 0
    /\ missilesReady = MaxMissiles
    /\ targetAlive = TRUE
    /\ lockTicks = 0
    /\ rearmPeriod = FreshRearm /\ rearmTicks = 0 /\ missileCooldown = 0
    /\ launchStock = -1

FlightInit == Init /\ projection = "flight"
CombatInit == Init /\ projection = "combat"

(* Charge bands have closed endpoints to cover floating-point rounding at a boundary.
   Rates below are charge units per frame. There are 600 units in one charge point. *)
Unit == 600
Full == 100 * Unit
MinOverdriveShield == 9000
OverdriveDrain == 240
ShieldRecharge == 100
WeaponRecharge == 240
OverheatCooldown == 150
ShotCost == 5700
BoltDamage == 8400
VentCharge == 7200
ShieldRestore == 3600
ShieldSurge == 15000
(* Lockout cooling is slower than normal recharge, and the lockout lasts exactly as long as
   cooling from 0 to Full takes at that rate. *)
ASSUME OverheatCooldown < WeaponRecharge
ASSUME (OverheatTicks - 1) * OverheatCooldown < Full /\ Full <= OverheatTicks * OverheatCooldown
(* Measured from the simulation: a trigger pull on a partially cooled, overheated gun. *)
OverheatedShotFires == FALSE
CanFire(state) == state = "ready" \/ OverheatedShotFires
WeaponEdges == <<0, 0, Full, Full>>
ShieldEdges == <<0, 0, MinOverdriveShield, Full, Full>>

Band(n, edges) ==
    CASE n < 0 -> -1 [] n > Full -> Len(edges) - 1
      [] n = 0 -> 0 [] n = Full -> Len(edges) - 2
      [] OTHER -> CHOOSE b \in 1..(Len(edges) - 3) : edges[b+1] <= n /\ n < edges[b+2]
Clamp(n) == IF n < 0 THEN 0 ELSE IF n > Full THEN Full ELSE n
After(b, delta, edges) ==
    IF delta = 0 THEN {b}
    ELSE Band(Clamp(edges[b+1] + delta), edges)..Band(Clamp(edges[b+2] + delta), edges)

Shoot(w) ==
    /\ primaryCooldown <= 1 /\ w > 0
    /\ \E afterShot \in After(w, -ShotCost, WeaponEdges) :
         /\ weaponCharge' = afterShot
         /\ weaponState' = IF afterShot = 0 THEN "overheated" ELSE "ready"
         /\ overheatTicks' = IF afterShot = 0 THEN OverheatTicks ELSE 0
    /\ primaryCooldown' = PrimaryCooldown

StepReadyWeapon(w) ==
    \/ /\ weaponCharge' = w
       /\ weaponState' = "ready"
       /\ overheatTicks' = 0
       /\ primaryCooldown' = IF primaryCooldown > 0 THEN primaryCooldown - 1 ELSE 0
    \/ Shoot(w)

StepOverheatedWeapon ==
    \/ /\ weaponState' = "overheated"
       /\ weaponCharge' = 1
       /\ overheatTicks' = overheatTicks - 1
       /\ primaryCooldown' = IF primaryCooldown > 0 THEN primaryCooldown - 1 ELSE 0
    \/ CanFire(weaponState) /\ Shoot(1)

Fly ==
    /\ projection = "flight"
    /\ \E enterOd \in BOOLEAN, cancelOd \in BOOLEAN :
         LET nextDelay == IF shieldDelay > 0 THEN shieldDelay - 1 ELSE 0
             odStart == IF cancelOd THEN FALSE
                        ELSE IF ~overdrive /\ enterOd /\ shieldCharge >= 2 THEN TRUE
                        ELSE overdrive
             shieldDelta == IF odStart THEN -OverdriveDrain
                            ELSE IF nextDelay = 0 THEN ShieldRecharge
                            ELSE 0
         IN /\ shieldDelay' = nextDelay
            /\ \E s \in After(shieldCharge, shieldDelta, ShieldEdges) :
                 /\ shieldCharge' = s
                 /\ overdrive' = IF odStart /\ s > 0 THEN TRUE ELSE FALSE
            /\ IF weaponState = "overheated" THEN
                 IF overheatTicks = 1 THEN StepReadyWeapon(2)
                 ELSE StepOverheatedWeapon
               ELSE \E w \in After(weaponCharge, WeaponRecharge, WeaponEdges) : StepReadyWeapon(w)
    /\ UNCHANGED <<projection, combat>>

(* Hostile bolts or collisions can hit after a flight update, resetting shield regen delay
   and dropping overdrive if shields hit zero. *)
ShieldHit ==
    /\ projection = "flight"
    /\ \E s \in After(shieldCharge, -BoltDamage, ShieldEdges) :
         /\ shieldCharge' = s
         /\ overdrive' = IF s = 0 THEN FALSE ELSE overdrive
    /\ shieldDelay' = ShieldRegenDelayTicks
    /\ UNCHANGED <<projection, primaryCooldown, weaponState, weaponCharge, overheatTicks, combat>>

(* Supply drops and near misses: a heat flush ends any lockout, a heat vent only tops up a ready gun,
   and shield surges or near-miss restores add charge. *)
HeatFlush ==
    /\ projection = "flight"
    /\ weaponState' = "ready" /\ weaponCharge' = 2 /\ overheatTicks' = 0
    /\ UNCHANGED <<projection, primaryCooldown, overdrive, shieldCharge, shieldDelay, combat>>

HeatVent ==
    /\ projection = "flight"
    /\ weaponState = "ready"
    /\ \E w \in After(weaponCharge, VentCharge, WeaponEdges) : weaponCharge' = w
    /\ UNCHANGED <<projection, primaryCooldown, overdrive, weaponState, overheatTicks, shieldCharge, shieldDelay, combat>>

ShieldGain ==
    /\ projection = "flight"
    /\ \E gain \in {ShieldRestore, ShieldSurge} : \E s \in After(shieldCharge, gain, ShieldEdges) : shieldCharge' = s
    /\ UNCHANGED <<projection, primaryCooldown, overdrive, weaponState, weaponCharge, overheatTicks, shieldDelay, combat>>

Resupply ==
    /\ projection = "combat"
    /\ missilesReady < MaxMissiles
    /\ missilesReady' = missilesReady + 1
    /\ launchStock' = -1
    /\ UNCHANGED <<projection, flight, targetAlive, lockTicks, rearmTicks, rearmPeriod, missileCooldown>>

Scan(stock) ==
    IF stock = 0 THEN {0}
    ELSE LET same == IF lockTicks = AcquireTicks THEN AcquireTicks ELSE lockTicks + 1
         IN {0, 1, same}

AfterImpact(progress, alive) == IF alive THEN progress ELSE 0

CombatFrame ==
    /\ projection = "combat"
    /\ LET full == missilesReady = MaxMissiles
           reload == ~full /\ rearmTicks + 1 = rearmPeriod
           stock == IF reload THEN missilesReady + 1 ELSE missilesReady
       IN /\ rearmPeriod' \in IF full THEN {FreshRearm}
                             ELSE IF ~reload THEN {rearmPeriod}
                             ELSE IF rearmPeriod = FreshRearm THEN {CarriedRearm}
                             ELSE {CarriedRearm, FreshRearm}
          /\ rearmTicks' = IF full \/ reload THEN 0 ELSE rearmTicks + 1
          /\ \E fired \in (IF stock > 0 /\ missileCooldown <= 1 THEN BOOLEAN ELSE {FALSE}) :
               /\ missilesReady' = IF fired THEN stock - 1 ELSE stock
               /\ launchStock' = IF fired THEN stock ELSE -1
               /\ missileCooldown' = IF fired THEN MissileCooldown
                                     ELSE IF missileCooldown > 0 THEN missileCooldown - 1 ELSE 0
               /\ targetAlive' \in BOOLEAN
               /\ \E progress \in Scan(stock) :
                     lockTicks' = AfterImpact(IF fired THEN 0 ELSE progress, targetAlive')
    /\ UNCHANGED <<projection, flight>>

Next == Fly \/ ShieldHit \/ CombatFrame \/ HeatFlush \/ HeatVent \/ ShieldGain \/ Resupply
Spec == Init /\ [][Next]_vars /\ WF_vars(Fly)
(* Liveness only concerns the flight machine, so TLC checks it on that projection alone. *)
FlightSpec == FlightInit /\ [][Next]_vars /\ WF_vars(Fly)

ChargesBounded == weaponCharge \in 0..2 /\ shieldCharge \in 0..3
WeaponStateValid == weaponState \in {"ready", "overheated"}
OverdriveHasShield == overdrive => shieldCharge > 0
AmmoBounded == missilesReady \in 0..MaxMissiles
LaunchHadAmmo == launchStock = -1 \/ launchStock \in 1..MaxMissiles
LockHasAmmo == LockState # "none" => missilesReady > 0
LockHasLiveTarget == LockState # "none" => targetAlive
TimerBounds ==
    /\ rearmPeriod \in {FreshRearm, CarriedRearm} /\ rearmTicks \in 0..(rearmPeriod - 1)
    /\ primaryCooldown \in 0..PrimaryCooldown /\ missileCooldown \in 0..MissileCooldown
    /\ shieldDelay \in 0..ShieldRegenDelayTicks /\ lockTicks \in 0..AcquireTicks
    /\ IF weaponState = "overheated" THEN overheatTicks \in 1..OverheatTicks ELSE overheatTicks = 0

OverheatCannotFireStep ==
    weaponState = "overheated" =>
        \/ UNCHANGED <<weaponState, overheatTicks, primaryCooldown>>
        \/ (overheatTicks > 1 /\ weaponState' = "overheated" /\ overheatTicks' = overheatTicks - 1 /\ primaryCooldown' <= primaryCooldown)
        \/ (overheatTicks = 1 /\ weaponState' = "ready" /\ overheatTicks' = 0)
        \/ (weaponState' = "ready" /\ overheatTicks' = 0 /\ primaryCooldown' = primaryCooldown)
OverheatCannotFire == [][OverheatCannotFireStep]_vars
OverheatCompletes == (weaponState = "overheated") ~> (weaponState = "ready")

NeverOverheated == weaponState # "overheated"
NeverOverdrive == ~overdrive
NeverFiredOnReload == ~(rearmPeriod = CarriedRearm /\ rearmTicks = 0 /\ launchStock = 1)
NeverLocked == LockState # "locked"
NeverFiredLastMissile == launchStock # 1
===============================================================================
