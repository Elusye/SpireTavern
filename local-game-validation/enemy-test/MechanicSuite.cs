using System.Diagnostics;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Map;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.Models.Characters;
using MegaCrit.Sts2.Core.Models.Orbs;
using MegaCrit.Sts2.Core.Models.Powers;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Unlocks;

namespace QQBotEnemyTest;

// Controlled fixtures use real original card/power/orb commands, not the QQ bot simulator.
internal static class MechanicSuite
{
    private static Player player = null!;
    private static Creature enemy = null!;
    private static bool active;
    private static bool victory;
    private static readonly List<object> events = new();
    private static readonly List<object> checks = new();
    private static readonly List<(int Hp, int Block, int EnemyHp)> attackStarts = new();
    private static readonly List<(int Hp, int Block, int EnemyHp)> attackEnds = new();
    private static readonly ThrowingPlayerChoiceContext context = new();
    private static PlayerCombatState State => player.PlayerCombatState!;
    private static int Weak => enemy.GetPower<WeakPower>()?.Amount ?? 0;
    private static int Vulnerable => enemy.GetPower<VulnerablePower>()?.Amount ?? 0;
    private static string OrbIds => string.Join(",", State.OrbQueue.Orbs.Select(o => o.Id.Entry));

    private static void Snapshot(string kind, object? detail = null)
    {
        events.Add(new {
            kind, detail, turn = State.TurnNumber, energy = State.Energy,
            playerHp = player.Creature.CurrentHp, playerBlock = player.Creature.Block,
            enemyHp = enemy.CurrentHp, enemyBlock = enemy.Block,
            playerPowers = player.Creature.Powers.Select(p => new { id = p.Id.Entry, amount = p.Amount }).ToArray(),
            enemyPowers = enemy.Powers.Select(p => new { id = p.Id.Entry, amount = p.Amount }).ToArray(),
            orbs = State.OrbQueue.Orbs.Select(o => new { id = o.Id.Entry, passive = o.PassiveVal, evoke = o.EvokeVal }).ToArray()
        });
    }

    public static void ObserveEnemy(string kind)
    {
        if (!active || enemy == null || (kind != "enemy_attack_start" && kind != "enemy_attack_end")) return;
        Snapshot(kind);
        var data = (player.Creature.CurrentHp, player.Creature.Block, enemy.CurrentHp);
        if (kind == "enemy_attack_start") attackStarts.Add(data); else attackEnds.Add(data);
    }

    private static void Equal<T>(string label, T actual, T expected)
    {
        bool passed = EqualityComparer<T>.Default.Equals(actual, expected);
        checks.Add(new { label, actual, expected, passed });
        GD.Print($"[QQBOT_CHECK] {label}: actual={actual} expected={expected} passed={passed}");
        if (!passed) throw new InvalidOperationException($"{label}: {actual} != {expected}");
    }

    public static async Task<bool> Run(string name)
    {
        events.Clear(); checks.Clear(); attackStarts.Clear(); attackEnds.Clear();
        active = false; victory = false;
        ResourceProbe.Mark("run_setup_start");
        bool passed = false;
        string? error = null;
        try
        {
            var unlocks = new UnlockState(SaveManager.Instance.Progress);
            CharacterModel character = name == "coverage" ? LegacyCardCoverage.Character : name == "duel" ? DuelConfig.Character(DuelConfig.First) : name switch {
                "weak" => ModelDb.Character<Silent>(),
                "orbs" => ModelDb.Character<Defect>(),
                _ => ModelDb.Character<Ironclad>()
            };
            var run = await NGame.Instance!.StartNewSingleplayerRun(character, false, ActModel.GetDefaultList(),
                Array.Empty<ModifierModel>(), name == "duel" ? DuelConfig.Seed : "QQBOTMECHANICS", GameMode.Standard);
            player = run.Players.Single();
            var encounter = ModelDb.Encounter<QQBotTestEncounter>().ToMutable();
            await RunManager.Instance.EnterRoomDebug(RoomType.Monster, MapPointType.Unassigned, encounter);
            await Until(() => CombatManager.Instance.IsInProgress && State.Phase == PlayerTurnPhase.Play, "start combat");
            enemy = player.Creature.CombatState!.Enemies.Single();
            active = true;
            await CardPileCmd.RemoveFromCombat(State.Hand.Cards.ToArray());
            // Explicit fixture energy only; every card still pays its original cost.
            await PlayerCmd.SetEnergy(20, player);
            Snapshot("fixture_ready", new { name, fixtureEnergy = 20 });
            switch (name)
            {
                case "expansion":
                    await ExpansionLifecycle.Run(player, Equal);
                    passed = true;
                    return true;
                case "catalog":
                    NativeCardMetadata.Export(player);
                    passed = true;
                    return true;
                case "lifecycle":
                    await DuelLifecycle.Run(player, Equal);
                    passed = true;
                    return true;
                case "coverage":
                    await LegacyCardCoverage.Run(player, Equal);
                    passed = true;
                    return true;
                case "vulnerable": await TestVulnerable(); break;
                case "weak": await TestWeak(); break;
                case "upgrades": await TestUpgrades(); break;
                case "orbs": await TestOrbs(); break;
                case "pvp": await TestPvp(); break;
                case "duel":
                    await DuelPrototype.Run(player, Equal);
                    passed = true;
                    return true;
                default: throw new ArgumentException(name);
            }
            Snapshot("checks_complete");
            // Teardown is deliberately distinct from mechanic evidence, not counted as damage.
            CombatManager.Instance.CombatWon += Won;
            Snapshot("fixture_teardown");
            await CreatureCmd.Kill(enemy);
            await CombatManager.Instance.CheckWinCondition();
            await Until(() => victory, "victory callback during teardown");
            passed = true;
        }
        catch (Exception ex) { error = ex.ToString(); GD.PrintErr("[QQBOT_CHECK] " + error); }
        finally
        {
            active = false;
            CombatManager.Instance.CombatWon -= Won;
            var output = System.Environment.GetEnvironmentVariable("QQBOT_TEST_OUTPUT")!;
            System.IO.File.WriteAllText(output, JsonSerializer.Serialize(new {
                passed, error, gameVersion = GameBuild.Version, modelHash = GameBuild.ModelHash, testCase = name, victory,
                fixture = "Controlled cards, original commands, 20 setup energy; teardown kill excluded from checks",
                checks, events
            }, new JsonSerializerOptions { WriteIndented = true }));
        }
        return passed;
    }

    private static void Won(CombatRoom _) => victory = true;
    private static async Task Until(Func<bool> predicate, string stage)
    {
        var timer = Stopwatch.StartNew();
        while (!predicate())
        {
            if (timer.Elapsed.TotalSeconds > 25) throw new TimeoutException(stage);
            await NGame.Instance!.ToSignal(NGame.Instance.GetTree(), SceneTree.SignalName.ProcessFrame);
        }
    }

    private static async Task Play<T>(bool upgrade = false) where T : CardModel
    {
        var card = player.Creature.CombatState!.CreateCard<T>(player);
        await CardPileCmd.Add(card, PileType.Hand, skipVisuals: true);
        if (upgrade) CardCmd.Upgrade(card);
        Equal($"{card.Id.Entry}{(upgrade ? "+" : "")} playable", card.CanPlay(), true);
        int energy = State.Energy;
        int cost = card.EnergyCost.GetAmountToSpend();
        Snapshot("card_before", new { card = card.Id.Entry, upgrade, cost });
        await card.SpendResources();
        await CardCmd.AutoPlay(context, card, card.TargetType == TargetType.AnyEnemy ? enemy : null,
            AutoPlayType.Default, skipXCapture: true);
        Snapshot("card_after", new { card = card.Id.Entry, upgrade, cost });
        Equal($"{card.Id.Entry} energy paid", energy - State.Energy, cost);
    }

    private static async Task NextTurn()
    {
        int turn = State.TurnNumber;
        Snapshot("end_turn");
        PlayerCmd.EndTurn(player, canBackOut: false);
        await Until(() => State.Phase == PlayerTurnPhase.Play && State.TurnNumber > turn, "next turn");
        Snapshot("next_turn");
        await CardPileCmd.RemoveFromCombat(State.Hand.Cards.ToArray());
    }

    private static async Task TestVulnerable()
    {
        int hp = enemy.CurrentHp;
        await Play<Bash>();
        Equal("Bash base damage", hp - enemy.CurrentHp, 8);
        Equal("Bash vulnerable duration", Vulnerable, 2);
        hp = enemy.CurrentHp;
        await Play<StrikeIronclad>();
        Equal("Vulnerable Strike 6 x 1.5", hp - enemy.CurrentHp, 9);
        await PowerCmd.Apply<WeakPower>(context, player.Creature, 1, enemy, null);
        hp = enemy.CurrentHp;
        await Play<StrikeIronclad>();
        Equal("Weak plus vulnerable floor(6 x .75 x 1.5)", hp - enemy.CurrentHp, 6);
        await NextTurn();
        Equal("Vulnerable ticks from 2 to 1", Vulnerable, 1);
        // Native 0.111.1 marks freshly applied player debuffs SkipNextDurationTick.
        // This fixture applies during the player's current turn, unlike a normal enemy attack.
        Equal("Fresh player weak skips first duration tick", player.Creature.GetPower<WeakPower>()?.Amount ?? 0, 1);
        await NextTurn();
        Equal("Vulnerable expires", Vulnerable, 0);
        Equal("Player weak expires on next duration tick", player.Creature.GetPower<WeakPower>()?.Amount ?? 0, 0);
        hp = enemy.CurrentHp;
        await Play<StrikeIronclad>();
        Equal("Damage returns to normal", hp - enemy.CurrentHp, 6);
    }

    private static async Task TestPvp()
    {
        var opponent = Player.CreateForNewRun<Silent>(new UnlockState(SaveManager.Instance.Progress), 2UL);
        ((RunState)player.RunState).AddPlayerDebug(opponent, -1);
        opponent.ResetCombatState();
        var combat = (CombatState)player.Creature.CombatState!;
        combat.AddPlayer(opponent);
        opponent.PlayerCombatState!.Phase = PlayerTurnPhase.Play;
        await PlayerCmd.SetEnergy(3, player);
        await PlayerCmd.SetEnergy(3, opponent);
        Equal("Two distinct player identities", player.NetId != opponent.NetId, true);
        Equal("Ironclad initial HP", player.Creature.CurrentHp, 80);
        Equal("Silent initial HP", opponent.Creature.CurrentHp, 70);
        var turns = new List<object>();
        async Task PlayAgainst<T>(Player owner, Player target) where T : CardModel
        {
            var card = combat.CreateCard<T>(owner);
            await CardPileCmd.Add(card, PileType.Hand, skipVisuals: true);
            int hp = target.Creature.CurrentHp;
            int energy = owner.PlayerCombatState!.Energy;
            await card.SpendResources();
            await CardCmd.AutoPlay(context, card, card.TargetType == TargetType.AnyEnemy ? target.Creature : null,
                AutoPlayType.Default, skipXCapture: true, skipCardPileVisuals: true);
            turns.Add(new { actor = owner.NetId, target = target.NetId, card = card.Id.Entry,
                energyBefore = energy, energyAfter = owner.PlayerCombatState.Energy,
                targetHpBefore = hp, targetHpAfter = target.Creature.CurrentHp,
                attackerBlock = owner.Creature.Block });
        }
        await PlayAgainst<DefendSilent>(opponent, player);
        Equal("Opponent builds own block", opponent.Creature.Block, 5);
        await PlayAgainst<StrikeIronclad>(player, opponent);
        Equal("Player attack consumes opponent block", opponent.Creature.Block, 0);
        Equal("Player attack damages actual opponent", opponent.Creature.CurrentHp, 69);
        await PlayAgainst<Neutralize>(opponent, player);
        Equal("Opponent attacks actual player", player.Creature.CurrentHp, 77);
        Equal("Opponent applies weak to player", player.Creature.GetPower<WeakPower>()?.Amount ?? 0, 1);
        await PlayAgainst<StrikeIronclad>(player, opponent);
        Equal("Player weak affects counterattack", opponent.Creature.CurrentHp, 65);
        Equal("Independent player energy", State.Energy, 1);
        Equal("Independent opponent energy", opponent.PlayerCombatState.Energy, 2);
        Snapshot("pvp_directed_card_probe", new { turns,
            limitation = "Two player entities retain original co-op side; explicit card targets only. Opponent routing and simultaneous settlement not implemented." });
    }

    private static async Task TestWeak()
    {
        int hp = enemy.CurrentHp;
        await Play<Neutralize>();
        Equal("Neutralize damage", hp - enemy.CurrentHp, 3);
        Equal("Neutralize weak duration", Weak, 1);
        hp = player.Creature.CurrentHp;
        await NextTurn();
        Equal("Weak enemy attack floor(6 x .75)", hp - player.Creature.CurrentHp, 4);
        Equal("Weak expires after enemy turn", Weak, 0);
        hp = player.Creature.CurrentHp;
        await NextTurn();
        Equal("Enemy attack restored after weak", hp - player.Creature.CurrentHp, 6);
        hp = enemy.CurrentHp;
        await Play<Neutralize>(true);
        Equal("Neutralize+ damage", hp - enemy.CurrentHp, 4);
        Equal("Neutralize+ weak duration", Weak, 2);
        hp = player.Creature.CurrentHp;
        await NextTurn();
        Equal("Weak+ first enemy attack", hp - player.Creature.CurrentHp, 4);
        Equal("Weak+ ticks to 1", Weak, 1);
        hp = player.Creature.CurrentHp;
        await NextTurn();
        Equal("Weak+ second enemy attack", hp - player.Creature.CurrentHp, 4);
        Equal("Weak+ expires", Weak, 0);
    }

    private static async Task TestUpgrades()
    {
        int hp = enemy.CurrentHp;
        await Play<StrikeIronclad>();
        Equal("Strike base damage", hp - enemy.CurrentHp, 6);
        hp = enemy.CurrentHp;
        await Play<StrikeIronclad>(true);
        Equal("Strike+ damage", hp - enemy.CurrentHp, 9);
        int block = player.Creature.Block;
        await Play<DefendIronclad>();
        Equal("Defend base block", player.Creature.Block - block, 5);
        block = player.Creature.Block;
        await Play<DefendIronclad>(true);
        Equal("Defend+ block", player.Creature.Block - block, 8);
        int energy = State.Energy;
        await Play<Dualcast>();
        Equal("Dualcast base cost", energy - State.Energy, 1);
        energy = State.Energy;
        await Play<Dualcast>(true);
        Equal("Dualcast+ cost", energy - State.Energy, 0);
        hp = enemy.CurrentHp;
        await Play<Bash>(true);
        Equal("Bash+ damage", hp - enemy.CurrentHp, 10);
        Equal("Bash+ vulnerable duration", Vulnerable, 3);
    }

    private static async Task TestOrbs()
    {
        Equal("Defect starting lightning orb", OrbIds, "LIGHTNING_ORB");
        OrbCmd.RemoveSlots(player, State.OrbQueue.Capacity);
        await OrbCmd.AddSlots(player, 3);
        await Play<Zap>();
        await Play<Coolheaded>();
        Equal("Channel order oldest to newest", OrbIds, "LIGHTNING_ORB,FROST_ORB");
        int hp = enemy.CurrentHp;
        await NextTurn();
        Equal("Lightning turn-end passive", hp - enemy.CurrentHp, 3);
        Equal("Frost grants block before enemy attack", attackStarts[^1].Block, 2);
        Equal("Frost block consumed by attack", attackEnds[^1].Block, 0);
        Equal("6 attack through 2 frost block", attackStarts[^1].Hp - attackEnds[^1].Hp, 4);
        Equal("Passive keeps orb queue", OrbIds, "LIGHTNING_ORB,FROST_ORB");
        hp = enemy.CurrentHp;
        await Play<Dualcast>();
        Equal("Dualcast lightning 8 x 2", hp - enemy.CurrentHp, 16);
        Equal("Dualcast removes just one orb", OrbIds, "FROST_ORB");
        int block = player.Creature.Block;
        await Play<Dualcast>(true);
        Equal("Dualcast+ frost block 5 x 2", player.Creature.Block - block, 10);
        Equal("Frost removed after dualcast", State.OrbQueue.Orbs.Count, 0);
        await PlayerCmd.SetEnergy(20, player);
        await Play<Zap>();
        await Play<Coolheaded>();
        await Play<Zap>(true);
        hp = enemy.CurrentHp;
        await Play<Coolheaded>();
        Equal("Full queue evokes oldest lightning", hp - enemy.CurrentHp, 8);
        Equal("Full queue order", OrbIds, "FROST_ORB,LIGHTNING_ORB,FROST_ORB");
        block = player.Creature.Block;
        await OrbCmd.EvokeNext(context, player);
        Equal("Oldest frost evoke", player.Creature.Block - block, 5);
        block = player.Creature.Block;
        await OrbCmd.EvokeLast(context, player);
        Equal("Newest frost evoke", player.Creature.Block - block, 5);
        Equal("Middle lightning remains", OrbIds, "LIGHTNING_ORB");
        await PowerCmd.Apply<VulnerablePower>(context, enemy, 2, player.Creature, null);
        await PowerCmd.Apply<WeakPower>(context, player.Creature, 2, enemy, null);
        hp = enemy.CurrentHp;
        await OrbCmd.Passive(context, State.OrbQueue.Orbs[0], enemy);
        Equal("Lightning passive ignores weak and vulnerable", hp - enemy.CurrentHp, 3);
        hp = enemy.CurrentHp;
        await OrbCmd.EvokeNext(context, player);
        Equal("Lightning evoke ignores weak and vulnerable", hp - enemy.CurrentHp, 8);
        await OrbCmd.Channel<FrostOrb>(context, player);
        block = player.Creature.Block;
        await OrbCmd.Passive(context, State.OrbQueue.Orbs[0], null);
        Equal("Frost passive under weak", player.Creature.Block - block, 2);
    }
}
