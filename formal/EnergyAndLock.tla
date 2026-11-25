----------------------------- MODULE EnergyAndLock -----------------------------
EXTENDS Integers, Sequences

VARIABLES projection, primaryCooldown, overdrive, weaponState, weaponHeat, overheatTicks, shieldCharge,
          shieldDelay, cannonFired, missilesReady, targetAlive, lockTicks, rearmTicks, rearmPeriod, missileCooldown,
          launchStock, recharging

flight == <<primaryCooldown, overdrive, weaponState, weaponHeat, overheatTicks, shieldCharge, shieldDelay, cannonFired>>
combat == <<missilesReady, targetAlive, lockTicks, rearmTicks, rearmPeriod, missileCooldown, launchStock>>
(* The `C` key is pilot input both state machines read, so each frame of either one chooses it. *)
vars == <<projection, flight, combat, recharging>>

(* With geometry supplied as input, each property depends on just one of
   these two state machines. Explore each projection from the initial ship. *)
MaxMissiles == 4
AcquireTicks == 48
FreshRearm == 720
CarriedRearm == 720
MissileCooldown == 34
PrimaryCooldown == 9
ShieldRegenDelayTicks == 133
OverheatTicks == 400
LockState == CASE lockTicks = 0 -> "none" [] lockTicks = AcquireTicks -> "locked" [] OTHER -> "acquiring"

Init ==
    /\ projection \in {"flight", "combat"}
    /\ primaryCooldown = 0
    /\ overdrive = FALSE
    /\ weaponState = "ready"
    /\ weaponHeat = 0
    /\ overheatTicks = 0
    /\ shieldCharge = 3
    /\ shieldDelay = 0
    /\ cannonFired = FALSE
    /\ recharging = FALSE
    /\ missilesReady = MaxMissiles
    /\ targetAlive = TRUE
    /\ lockTicks = 0
    /\ rearmPeriod = FreshRearm /\ rearmTicks = 0 /\ missileCooldown = 0
    /\ launchStock = -1

FlightInit == Init /\ projection = "flight"
CombatInit == Init /\ projection = "combat"

(* Heat and shield bands have closed endpoints to cover floating-point rounding at a boundary.
   Rates below are units per frame. There are 600 units in one point; heat runs 0 (cold) to Full. *)
Unit == 600
Full == 100 * Unit
MinOverdriveShield == 9000
OverdriveDrain == 240
ShieldRecharge == 100
ManualRecharge == 280
WeaponCool == 240
OverheatCool == 150
ShotHeat == 5700
HotHeat == 48000
BoltDamage == 8400
VentHeat == 7200
ShieldRestore == 3600
ShieldSurge == 15000
(* Lockout cooling is slower than normal cooling, and the lockout lasts exactly as long as
   cooling from Full to 0 takes at that rate. *)
ASSUME OverheatCool < WeaponCool
ASSUME (OverheatTicks - 1) * OverheatCool < Full /\ Full <= OverheatTicks * OverheatCool
ASSUME 0 < HotHeat /\ HotHeat < Full
(* Measured from the simulation: a trigger pull on a partially cooled, overheated gun, and what holding
   manual recharge lets through. *)
OverheatedShotFires == FALSE
RechargeAllowsFire == FALSE
RechargeAllowsOverdrive == FALSE
CanFire(state) == state = "ready" \/ OverheatedShotFires
CanFireWhile(recharge) == ~recharge \/ RechargeAllowsFire
(* Heat bands: 0 cold, 1 warm, 2 the Hot Zone from HotHeat up, 3 at Full, which only an overheat reaches. *)
WeaponEdges == <<0, 0, HotHeat, Full, Full>>
FullHeat == Len(WeaponEdges) - 2
HotBand == 2
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
    /\ primaryCooldown <= 1 /\ w < FullHeat
    /\ \E afterShot \in After(w, ShotHeat, WeaponEdges) :
         /\ weaponHeat' = afterShot
         /\ weaponState' = IF afterShot = FullHeat THEN "overheated" ELSE "ready"
         /\ overheatTicks' = IF afterShot = FullHeat THEN OverheatTicks ELSE 0
    /\ primaryCooldown' = PrimaryCooldown
    /\ cannonFired' = TRUE

Hold(w) ==
    /\ weaponHeat' = w
    /\ weaponState' = "ready"
    /\ overheatTicks' = 0
    /\ primaryCooldown' = IF primaryCooldown > 0 THEN primaryCooldown - 1 ELSE 0
    /\ cannonFired' = FALSE

StepReadyWeapon(w, recharge) == Hold(w) \/ (CanFireWhile(recharge) /\ Shoot(w))

(* A locked-out gun sits somewhere between the Hot Zone and cold while it cools; which band is left open. *)
StepOverheatedWeapon(recharge) ==
    \/ /\ weaponState' = "overheated"
       /\ weaponHeat' \in 1..FullHeat
       /\ overheatTicks' = overheatTicks - 1
       /\ primaryCooldown' = IF primaryCooldown > 0 THEN primaryCooldown - 1 ELSE 0
       /\ cannonFired' = FALSE
    \/ CanFire(weaponState) /\ CanFireWhile(recharge) /\ Shoot(weaponHeat)

(* Holding recharge drops Overdrive and refuses it, fills shields past the regen delay, holds a ready
   gun's heat and lets a lockout keep cooling. *)
Fly ==
    /\ projection = "flight"
    /\ \E enterOd \in BOOLEAN, cancelOd \in BOOLEAN, recharge \in BOOLEAN :
         LET nextDelay == IF shieldDelay > 0 THEN shieldDelay - 1 ELSE 0
             blocked == recharge /\ ~RechargeAllowsOverdrive
             odStart == IF cancelOd \/ blocked THEN FALSE
                        ELSE IF ~overdrive /\ enterOd /\ shieldCharge >= 2 THEN TRUE
                        ELSE overdrive
             shieldDelta == IF odStart THEN -OverdriveDrain
                            ELSE IF recharge THEN ManualRecharge
                            ELSE IF nextDelay = 0 THEN ShieldRecharge
                            ELSE 0
         IN /\ recharging' = recharge
            /\ shieldDelay' = nextDelay
            /\ \E s \in After(shieldCharge, shieldDelta, ShieldEdges) :
                 /\ shieldCharge' = s
                 /\ overdrive' = IF odStart /\ s > 0 THEN TRUE ELSE FALSE
            /\ IF weaponState = "overheated" THEN
                 IF overheatTicks = 1 THEN StepReadyWeapon(0, recharge)
                 ELSE StepOverheatedWeapon(recharge)
               ELSE IF recharge THEN StepReadyWeapon(weaponHeat, recharge)
               ELSE \E w \in After(weaponHeat, -WeaponCool, WeaponEdges) : StepReadyWeapon(w, recharge)
    /\ UNCHANGED <<projection, combat>>

(* Hostile bolts or collisions can hit after a flight update, resetting shield regen delay
   and dropping overdrive if shields hit zero. *)
ShieldHit ==
    /\ projection = "flight"
    /\ \E s \in After(shieldCharge, -BoltDamage, ShieldEdges) :
         /\ shieldCharge' = s
         /\ overdrive' = IF s = 0 THEN FALSE ELSE overdrive
    /\ shieldDelay' = ShieldRegenDelayTicks
    /\ UNCHANGED <<projection, primaryCooldown, weaponState, weaponHeat, overheatTicks, cannonFired, combat, recharging>>

(* Supply drops and near misses: a heat flush ends any lockout cold, a heat vent only cools a ready gun,
   and shield surges or near-miss restores add charge. *)
HeatFlush ==
    /\ projection = "flight"
    /\ weaponState' = "ready" /\ weaponHeat' = 0 /\ overheatTicks' = 0
    /\ UNCHANGED <<projection, primaryCooldown, overdrive, shieldCharge, shieldDelay, cannonFired, combat, recharging>>

HeatVent ==
    /\ projection = "flight"
    /\ weaponState = "ready"
    /\ \E w \in After(weaponHeat, -VentHeat, WeaponEdges) : weaponHeat' = w
    /\ UNCHANGED <<projection, primaryCooldown, overdrive, weaponState, overheatTicks, shieldCharge, shieldDelay, cannonFired, combat, recharging>>

ShieldGain ==
    /\ projection = "flight"
    /\ \E gain \in {ShieldRestore, ShieldSurge} : \E s \in After(shieldCharge, gain, ShieldEdges) : shieldCharge' = s
    /\ UNCHANGED <<projection, primaryCooldown, overdrive, weaponState, weaponHeat, overheatTicks, shieldDelay, cannonFired, combat, recharging>>

Resupply ==
    /\ projection = "combat"
    /\ missilesReady < MaxMissiles
    /\ missilesReady' = missilesReady + 1
    /\ launchStock' = -1
    /\ UNCHANGED <<projection, flight, targetAlive, lockTicks, rearmTicks, rearmPeriod, missileCooldown, recharging>>

Scan(stock) ==
    IF stock = 0 THEN {0}
    ELSE LET same == IF lockTicks = AcquireTicks THEN AcquireTicks ELSE lockTicks + 1
         IN {0, 1, same}

AfterImpact(progress, alive) == IF alive THEN progress ELSE 0

CombatFrame ==
    /\ projection = "combat"
    /\ \E recharge \in BOOLEAN : recharging' = recharge
    /\ LET full == missilesReady = MaxMissiles
           reload == ~full /\ rearmTicks + 1 = rearmPeriod
           stock == IF reload THEN missilesReady + 1 ELSE missilesReady
       IN /\ rearmPeriod' \in IF full THEN {FreshRearm}
                             ELSE IF ~reload THEN {rearmPeriod}
                             ELSE IF rearmPeriod = FreshRearm THEN {CarriedRearm}
                             ELSE {CarriedRearm, FreshRearm}
          /\ rearmTicks' = IF full \/ reload THEN 0 ELSE rearmTicks + 1
          /\ \E fired \in (IF stock > 0 /\ missileCooldown <= 1 /\ CanFireWhile(recharging') THEN BOOLEAN ELSE {FALSE}) :
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

ChargesBounded == weaponHeat \in 0..FullHeat /\ shieldCharge \in 0..3
HotZone == weaponState = "ready" /\ weaponHeat = HotBand
(* Only a lockout ever sits at Full heat. *)
FullHeatIsOverheat == weaponHeat = FullHeat => weaponState = "overheated"
RechargeExclusive ==
    recharging => (~overdrive /\ ~cannonFired /\ launchStock = -1)
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
NeverHotZone == ~HotZone
NeverRecharging == ~recharging
NeverOverdrive == ~overdrive
NeverFiredOnReload == ~(rearmPeriod = CarriedRearm /\ rearmTicks = 0 /\ launchStock = 1)
NeverLocked == LockState # "locked"
NeverFiredLastMissile == launchStock # 1
===============================================================================
