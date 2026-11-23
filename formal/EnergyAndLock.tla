----------------------------- MODULE EnergyAndLock -----------------------------
EXTENDS Integers, Sequences

VARIABLES projection, primaryCooldown, boostMode, engineCharge, weaponCharge, shieldCharge,
          driftTicks, recoveryTicks, missilesReady, targetAlive, lockTicks, rearmTicks, rearmPeriod, missileCooldown, launchStock

flight == <<primaryCooldown, boostMode, engineCharge, weaponCharge, shieldCharge, driftTicks, recoveryTicks>>
combat == <<missilesReady, targetAlive, lockTicks, rearmTicks, rearmPeriod, missileCooldown, launchStock>>
vars == <<projection, flight, combat>>

(* With geometry supplied as input, each property depends on just one of
   these two state machines. Explore each projection from the initial ship. *)
MaxMissiles == 4
(* Measured at FIXED_DT: drift starts at elapsed zero on its entry frame. *)
MaxDriftTicks == 121
BoostRecovery == 39
DriftRecovery == 45
AcquireTicks == 48
FreshRearm == 241
CarriedRearm == 240
MissileCooldown == 31
PrimaryCooldown == 8
LockState == CASE lockTicks = 0 -> "none" [] lockTicks = AcquireTicks -> "locked" [] OTHER -> "acquiring"

Init ==
    /\ projection \in {"flight", "combat"}
    /\ primaryCooldown = 0
    /\ boostMode = "ready"
    /\ engineCharge = 4
    /\ weaponCharge = 3
    /\ shieldCharge = 2
    /\ driftTicks = 0
    /\ recoveryTicks = 0
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
DriftThreshold == 9600
BoostThreshold == 12000
EngineRecharge == 180
RecoveryRecharge == 108
WeaponRecharge == 220
DriftWeaponRecharge == 154
ShieldRecharge == 100
DriftDrain == 240
BoostDrain == 300
BoostWeaponDraw == 80
ShotCost == 2700
BoltDamage == 3600
EngineEdges == <<0, 0, DriftThreshold, BoostThreshold, Full, Full>>
WeaponEdges == <<0, 0, ShotCost, Full, Full>>
ShieldEdges == <<0, 0, Full, Full>>
Band(n, edges) ==
    CASE n < 0 -> -1 [] n > Full -> Len(edges) - 1
      [] n = 0 -> 0 [] n = Full -> Len(edges) - 2
      [] OTHER -> CHOOSE b \in 1..(Len(edges) - 3) : edges[b+1] <= n /\ n < edges[b+2]
Clamp(n) == IF n < 0 THEN 0 ELSE IF n > Full THEN Full ELSE n
After(b, delta, edges) ==
    IF delta = 0 THEN {b}
    ELSE Band(Clamp(edges[b+1] + delta), edges)..Band(Clamp(edges[b+2] + delta), edges)

FirePrimary(w) ==
    \/ /\ weaponCharge' = w
       /\ primaryCooldown' = IF primaryCooldown > 0 THEN primaryCooldown - 1 ELSE 0
    \/ /\ primaryCooldown <= 1 /\ w >= 2
       /\ weaponCharge' \in After(w, -ShotCost, WeaponEdges)
       /\ primaryCooldown' = PrimaryCooldown

Frame(mode, charge, drift, recovery, weaponDelta) ==
    /\ boostMode' = mode /\ engineCharge' = charge
    /\ driftTicks' = drift /\ recoveryTicks' = recovery
    /\ \E w \in After(weaponCharge, weaponDelta, WeaponEdges) : FirePrimary(w)
    /\ shieldCharge' \in After(shieldCharge, ShieldRecharge, ShieldEdges)
    /\ UNCHANGED <<projection, combat>>

PilotInput(boost, drift) ==
    IF boostMode \in {"ready", "boosting"} /\ drift /\ engineCharge >= 2
    THEN \E c \in After(engineCharge, -DriftDrain, EngineEdges) : Frame("drifting", c, 0, 0, 0)
    ELSE CASE boostMode = "ready" ->
           IF boost /\ engineCharge >= 3
           THEN \E c \in After(engineCharge, -BoostDrain, EngineEdges) : Frame("boosting", c, 0, 0, -BoostWeaponDraw)
           ELSE \E c \in After(engineCharge, EngineRecharge, EngineEdges) : Frame("ready", c, 0, 0, WeaponRecharge)
      [] boostMode = "boosting" ->
           IF boost /\ engineCharge > 0
           THEN \E c \in After(engineCharge, -BoostDrain, EngineEdges) :
                    IF c = 0 THEN Frame("recovering", c, 0, BoostRecovery, -BoostWeaponDraw)
                             ELSE Frame("boosting", c, 0, 0, -BoostWeaponDraw)
           ELSE Frame("recovering", engineCharge, 0, BoostRecovery, 0)
      [] boostMode = "drifting" ->
           \E c \in After(engineCharge, -DriftDrain, EngineEdges) :
               IF ~drift \/ c = 0 \/ driftTicks + 1 >= MaxDriftTicks
               THEN Frame("recovering", c, 0, DriftRecovery, DriftWeaponRecharge)
               ELSE Frame("drifting", c, driftTicks + 1, 0, DriftWeaponRecharge)

Fly ==
    /\ projection = "flight" /\ boostMode # "recovering"
    /\ \E boost \in BOOLEAN, drift \in BOOLEAN : PilotInput(boost, drift)

Recover ==
    /\ projection = "flight" /\ boostMode = "recovering"
    /\ \E c \in After(engineCharge, RecoveryRecharge, EngineEdges) :
           Frame(IF recoveryTicks = 1 THEN "ready" ELSE "recovering",
                 c, 0, recoveryTicks - 1, WeaponRecharge)

(* Several hostile bolts can hit after a flight update. Each impact is a separate step. *)
ShieldHit ==
    /\ projection = "flight"
    /\ shieldCharge' \in After(shieldCharge, -BoltDamage, ShieldEdges)
    /\ UNCHANGED <<projection, primaryCooldown, boostMode, engineCharge, weaponCharge, driftTicks, recoveryTicks, combat>>

Scan(stock) ==
    IF stock = 0 THEN {0}
    ELSE LET same == IF lockTicks = AcquireTicks THEN AcquireTicks ELSE lockTicks + 1
         IN {0, 1, same}  \* no contact/out of cone, new contact, same contact

AfterImpact(progress, alive) == IF alive THEN progress ELSE 0

(* A full rack clears the fractional timer before firing. From zero, the first reload
   takes 241 updates. Subtraction retains the overshoot: a long interval is followed
   by a short one. After a short interval the remaining fraction is abstracted. *)
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

Next == Fly \/ Recover \/ ShieldHit \/ CombatFrame
Spec == Init /\ [][Next]_vars /\ WF_vars(Recover)

ChargesBounded == engineCharge \in 0..4 /\ weaponCharge \in 0..3 /\ shieldCharge \in 0..2
AmmoBounded == missilesReady \in 0..MaxMissiles
LaunchHadAmmo == launchStock = -1 \/ launchStock \in 1..MaxMissiles
LockHasAmmo == LockState # "none" => missilesReady > 0
LockHasLiveTarget == LockState # "none" => targetAlive
TimerBounds ==
    /\ rearmPeriod \in {FreshRearm, CarriedRearm} /\ rearmTicks \in 0..(rearmPeriod - 1)
    /\ primaryCooldown \in 0..PrimaryCooldown /\ missileCooldown \in 0..MissileCooldown
    /\ driftTicks \in 0..(MaxDriftTicks - 1) /\ lockTicks \in 0..AcquireTicks
    /\ boostMode # "drifting" => driftTicks = 0
    /\ IF boostMode = "recovering" THEN recoveryTicks \in 1..DriftRecovery ELSE recoveryTicks = 0
BoostModeValid == boostMode \in {"ready", "boosting", "drifting", "recovering"}

RecoveryStep ==
    boostMode = "recovering" =>
        \/ UNCHANGED <<boostMode, recoveryTicks>>
        \/ /\ recoveryTicks' = recoveryTicks - 1
           /\ boostMode' = IF recoveryTicks > 1 THEN "recovering" ELSE "ready"
RecoveryCannotBeSkipped == [][RecoveryStep]_vars
RecoveryCompletes == (boostMode = "recovering") ~> (boostMode = "ready")

NeverAtDriftLimit == ~(boostMode = "drifting" /\ driftTicks = MaxDriftTicks - 1)
NeverFiredOnReload == ~(rearmPeriod = CarriedRearm /\ rearmTicks = 0 /\ launchStock = 1)
NeverRecovering == boostMode # "recovering"
NeverLocked == LockState # "locked"
NeverFiredLastMissile == launchStock # 1
===============================================================================
