----------------------------- MODULE EnergyAndLock -----------------------------
EXTENDS Integers

VARIABLES projection, powerMode, boostMode, engineCharge, weaponCharge, shieldCharge,
          driftTicks, recoveryTicks, missilesReady, targetAlive, lockTicks, rearmTicks, launchStock

flight == <<powerMode, boostMode, engineCharge, weaponCharge, shieldCharge, driftTicks, recoveryTicks>>
combat == <<missilesReady, targetAlive, lockTicks, rearmTicks, launchStock>>
vars == <<projection, flight, combat>>

(* With geometry supplied as input, each property depends on just one of
   these two state machines. Explore each projection from the initial ship. *)
Power == {"engines", "balanced", "weapons"}
MaxMissiles == 4
(* Measured at FIXED_DT: drift starts at elapsed zero on its entry frame. *)
MaxDriftTicks == 133
BoostRecovery == 45
DriftRecovery == 57
AcquireTicks == 55
RearmPeriod == 270
LockState == CASE lockTicks = 0 -> "none" [] lockTicks = AcquireTicks -> "locked" [] OTHER -> "acquiring"

Init ==
    /\ projection \in {"flight", "combat"}
    /\ powerMode = "balanced"
    /\ boostMode = "ready"
    /\ engineCharge = 4
    /\ weaponCharge = 2
    /\ shieldCharge = 2
    /\ driftTicks = 0
    /\ recoveryTicks = 0
    /\ missilesReady = MaxMissiles
    /\ targetAlive = TRUE
    /\ lockTicks = 0
    /\ rearmTicks = 0
    /\ launchStock = -1

(* One charge point is 600 units, so every 60 Hz rate, including half and
   0.6 recharge, is integral. Closed interval endpoints overapproximate charge
   within a band. Engine bands split at the actual engage thresholds. *)
Unit == 600
Full == 100 * Unit
DriftThreshold == 18 * Unit
BoostThreshold == 22 * Unit
Edges(engine) == IF engine THEN <<0, 0, DriftThreshold, BoostThreshold, Full, Full>> ELSE <<0, 0, Full, Full>>
Band(n, engine) ==
    CASE n < 0 -> -1 [] n > Full -> 5 [] n = 0 -> 0
      [] n = Full -> IF engine THEN 4 ELSE 2
      [] n > 0 /\ n < Full -> IF ~engine \/ n < DriftThreshold THEN 1 ELSE IF n < BoostThreshold THEN 2 ELSE 3
Clamp(n) == IF n < 0 THEN 0 ELSE IF n > Full THEN Full ELSE n
After(b, delta, engine) ==
    IF delta = 0 THEN {b} ELSE
    LET edges == Edges(engine)
    IN Band(Clamp(edges[b+1] + delta), engine)..Band(Clamp(edges[b+2] + delta), engine)

EngineRate(p) == CASE p = "engines" -> 24 [] p = "balanced" -> 15 [] OTHER -> 9
WeaponRate(p) == CASE p = "engines" -> 9 [] p = "balanced" -> 17 [] OTHER -> 27
ShieldRate(p) == CASE p = "engines" -> 5 [] p = "balanced" -> 9 [] OTHER -> 7

Frame(p, mode, charge, drift, recovery, weaponDelta) ==
    /\ powerMode' = p /\ boostMode' = mode /\ engineCharge' = charge
    /\ driftTicks' = drift /\ recoveryTicks' = recovery
    /\ weaponCharge' \in After(weaponCharge, weaponDelta, FALSE)
    /\ shieldCharge' \in After(shieldCharge, 10 * ShieldRate(p), FALSE)
    /\ UNCHANGED <<projection, combat>>

PilotInput(p, boost, drift) ==
    IF boostMode \in {"ready", "boosting"} /\ drift /\ engineCharge >= 2
    THEN \E c \in After(engineCharge, -260, TRUE) : Frame(p, "drifting", c, 0, 0, 0)
    ELSE CASE boostMode = "ready" ->
           IF boost /\ engineCharge >= 3
           THEN \E c \in After(engineCharge, -320, TRUE) : Frame(p, "boosting", c, 0, 0, -100)
           ELSE \E c \in After(engineCharge, 10 * EngineRate(p), TRUE) : Frame(p, "ready", c, 0, 0, 10 * WeaponRate(p))
      [] boostMode = "boosting" ->
           IF boost /\ engineCharge > 0
           THEN \E c \in After(engineCharge, -320, TRUE) :
                    IF c = 0 THEN Frame(p, "recovering", c, 0, BoostRecovery, -100)
                             ELSE Frame(p, "boosting", c, 0, 0, -100)
           ELSE Frame(p, "recovering", engineCharge, 0, BoostRecovery, 0)
      [] boostMode = "drifting" ->
           \E c \in After(engineCharge, -260, TRUE) :
               IF ~drift \/ c = 0 \/ driftTicks + 1 >= MaxDriftTicks
               THEN Frame(p, "recovering", c, 0, DriftRecovery, 6 * WeaponRate(p))
               ELSE Frame(p, "drifting", c, driftTicks + 1, 0, 6 * WeaponRate(p))

Fly ==
    /\ projection = "flight" /\ boostMode # "recovering"
    /\ \E p \in Power, boost \in BOOLEAN, drift \in BOOLEAN : PilotInput(p, boost, drift)

Recover ==
    /\ projection = "flight" /\ boostMode = "recovering"
    /\ \E p \in Power : \E c \in After(engineCharge, 5 * EngineRate(p), TRUE) :
           Frame(p, IF recoveryTicks = 1 THEN "ready" ELSE "recovering",
                 c, 0, recoveryTicks - 1, 10 * WeaponRate(p))

(* A primary shot costs 5.5 points and each hostile bolt deals 8. The
   middle weapon band includes values both above and below the shot cost. *)
CombatDraw ==
    /\ projection = "flight"
    /\ \/ /\ weaponCharge > 0 /\ weaponCharge' \in After(weaponCharge, -3300, FALSE)
          /\ UNCHANGED shieldCharge
       \/ /\ shieldCharge' \in After(shieldCharge, -4800, FALSE) /\ UNCHANGED weaponCharge
    /\ UNCHANGED <<projection, powerMode, boostMode, engineCharge, driftTicks, recoveryTicks, combat>>

Scan(stock, contact, inCone) ==
    IF stock = 0 \/ contact = "absent" \/ ~inCone THEN 0
    ELSE IF contact = "new" THEN 1
    ELSE IF lockTicks = AcquireTicks THEN AcquireTicks ELSE lockTicks + 1

AfterImpact(progress, alive) == IF alive THEN progress ELSE 0

(* Reload retains fractional overshoot. At 60 Hz, expiry can fall on the
   270th or 271st frame. Cooldown eligibility and geometry are abstract inputs.
   A new contact always starts a new acquisition. *)
CombatFrame ==
    /\ projection = "combat"
    /\ \E contact \in (IF targetAlive THEN {"same", "new"} ELSE {"absent", "new"}),
          inCone \in BOOLEAN, atThreshold \in BOOLEAN, triggerOffCooldown \in BOOLEAN :
         LET reload == missilesReady < MaxMissiles /\
                       (rearmTicks = RearmPeriod \/ (rearmTicks + 1 = RearmPeriod /\ atThreshold))
             stock == IF reload THEN missilesReady + 1 ELSE missilesReady
             scanned == Scan(stock, contact, inCone)
             fired == triggerOffCooldown /\ stock > 0
         IN /\ targetAlive' \in (IF contact = "absent" THEN {FALSE} ELSE BOOLEAN)
            /\ rearmTicks' = IF missilesReady = MaxMissiles \/ reload THEN 0 ELSE rearmTicks + 1
            /\ missilesReady' = IF fired THEN stock - 1 ELSE stock
            /\ launchStock' = IF fired THEN stock ELSE -1
            /\ lockTicks' = AfterImpact(IF fired THEN 0 ELSE scanned, targetAlive')
    /\ UNCHANGED <<projection, flight>>

Next == Fly \/ Recover \/ CombatDraw \/ CombatFrame
Spec == Init /\ [][Next]_vars /\ WF_vars(Recover)

ChargesBounded == engineCharge \in 0..4 /\ weaponCharge \in 0..2 /\ shieldCharge \in 0..2
AmmoBounded == missilesReady \in 0..MaxMissiles
LaunchHadAmmo == launchStock = -1 \/ launchStock \in 1..MaxMissiles
LockHasAmmo == LockState # "none" => missilesReady > 0
LockHasLiveTarget == LockState # "none" => targetAlive
TimerBounds ==
    /\ rearmTicks \in 0..RearmPeriod
    /\ driftTicks \in 0..(MaxDriftTicks - 1) /\ lockTicks \in 0..AcquireTicks
    /\ boostMode # "drifting" => driftTicks = 0
    /\ IF boostMode = "recovering" THEN recoveryTicks \in 1..DriftRecovery ELSE recoveryTicks = 0
ModesValid == powerMode \in Power /\ boostMode \in {"ready", "boosting", "drifting", "recovering"}

RecoveryStep ==
    boostMode = "recovering" =>
        \/ UNCHANGED <<boostMode, recoveryTicks>>
        \/ /\ recoveryTicks' = recoveryTicks - 1
           /\ boostMode' = IF recoveryTicks > 1 THEN "recovering" ELSE "ready"
RecoveryCannotBeSkipped == [][RecoveryStep]_vars
RecoveryCompletes == (boostMode = "recovering") ~> (boostMode = "ready")

NeverAtDriftLimit == ~(boostMode = "drifting" /\ driftTicks = MaxDriftTicks - 1)
NeverRecovering == boostMode # "recovering"
NeverLocked == LockState # "locked"
NeverFiredLastMissile == launchStock # 1
===============================================================================
