using System.Diagnostics;
using System.Text.Json;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Helpers;
using MegaCrit.Sts2.Core.Map;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Characters;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Settings;
using MegaCrit.Sts2.Core.Unlocks;

namespace QQBotEnemyTest;

[ModInitializer(nameof(Initialize))]
public static class Entry
{
    public static void Initialize()
    {
        if (!CommandLineHelper.HasArg("qqbot-test-enemy")) return;
        GameBuild.Verify();
        if (LeanResources.Enabled)
        {
            MegaCrit.Sts2.Core.Assets.PreloadManager.Enabled = false;
            GD.Print("[QQBOT_RESOURCES] lean: bulk preload disabled, generic VFX disabled");
        }
        new Harmony("qqbot.local.enemy-test").PatchAll(typeof(Entry).Assembly);
        GD.Print("[QQBOT_TEST] Test mod initialized");
    }
}

[HarmonyPatch(typeof(NGame), "LaunchMainMenu")]
internal static class StartTestPatch
{
    private static void Prefix(ref bool skipLogo) => skipLogo = true;
    private static void Postfix(ref Task __result) => __result = TestRun.AfterMenu(__result);
}

public static class TestRun
{
    private static Player? player;
    private static MegaCrit.Sts2.Core.Entities.Creatures.Creature? enemy;
    private static readonly List<object> events = new();
    private static bool started;
    private static bool won;
    private static string Output => System.Environment.GetEnvironmentVariable("QQBOT_TEST_OUTPUT")
        ?? System.IO.Path.Combine(AppContext.BaseDirectory, "qqbot-test-result.json");

    public static void Record(string kind, object? detail = null)
    {
        MechanicSuite.ObserveEnemy(kind);
        var state = player?.PlayerCombatState;
        events.Add(new {
            kind, detail, turn = state?.TurnNumber, energy = state?.Energy,
            playerHp = player?.Creature.CurrentHp, playerBlock = player?.Creature.Block,
            enemyHp = enemy?.CurrentHp, enemyBlock = enemy?.Block,
            enemyPowers = enemy?.Powers.Select(p => new { id = p.Id.Entry, amount = p.Amount }).ToArray()
        });
        GD.Print($"[QQBOT_TEST] {kind} turn={state?.TurnNumber} energy={state?.Energy} HP={player?.Creature.CurrentHp}:{enemy?.CurrentHp}");
    }

    public static async Task AfterMenu(Task original)
    {
        await original;
        if (started) return;
        started = true;
        ResourceProbe.Mark("main_menu_ready");
        int exit = 1;
        try
        {
            if (System.Environment.GetEnvironmentVariable("QQBOT_TEST_MUTED") == "1")
            {
                var audio = SaveManager.Instance.SettingsSave;
                if (audio.VolumeMaster != 0 || audio.VolumeBgm != 0 || audio.VolumeSfx != 0 || audio.VolumeAmbience != 0)
                    throw new InvalidOperationException("Test audio settings were not muted");
                GD.Print("[QQBOT_AUDIO] Verified master=0 bgm=0 sfx=0 ambience=0");
            }
            NonInteractiveMode.AutoSlayerCheck = () => true;
            SaveManager.Instance.SetFtuesEnabled(false);
            SaveManager.Instance.PrefsSave.FastMode = FastModeType.Instant;
            var residentDirectory = System.Environment.GetEnvironmentVariable("QQBOT_RESIDENT_DIR");
            if (!string.IsNullOrEmpty(residentDirectory))
            {
                await ResidentHost.Run(residentDirectory);
                exit = 0;
                return;
            }
            var mechanic = System.Environment.GetEnvironmentVariable("QQBOT_TEST_CASE");
            if (!string.IsNullOrEmpty(mechanic))
            {
                int repeat = int.TryParse(System.Environment.GetEnvironmentVariable("QQBOT_BENCH_COUNT"), out var count) ? count : 1;
                exit = (repeat > 1 ? await ResourceProbe.Repeat(mechanic, repeat) : await MechanicSuite.Run(mechanic)) ? 0 : 1;
                return;
            }
            // v0.111.1 creates the local player inside StartNewSingleplayerRun.
            Record("starting_run", new { seed = "QQBOTTEST", enemyHealth = QQBotTrainingDummy.Health, enemyDamage = QQBotTrainingDummy.AttackDamage });
            var run = await NGame.Instance.StartNewSingleplayerRun(ModelDb.Character<Ironclad>(), shouldSave: false,
                ActModel.GetDefaultList(), Array.Empty<ModifierModel>(), "QQBOTTEST", GameMode.Standard);
            player = run.Players.Single();
            var encounter = ModelDb.Encounter<QQBotTestEncounter>().ToMutable();
            CombatManager.Instance.CombatWon += OnWon;
            await RunManager.Instance.EnterRoomDebug(RoomType.Monster, MapPointType.Unassigned, encounter);
            await Until(() => CombatManager.Instance.IsInProgress, "combat start");
            enemy = player.Creature.CombatState!.Enemies.Single();
            Record("combat_started");
            int lastTurn = 0;
            while (!won && player.Creature.IsAlive && CombatManager.Instance.IsInProgress)
            {
                await Until(() => won || !CombatManager.Instance.IsInProgress ||
                    (player.PlayerCombatState?.Phase == PlayerTurnPhase.Play && player.PlayerCombatState.TurnNumber > lastTurn), "player turn");
                if (won || !CombatManager.Instance.IsInProgress) break;
                var state = player.PlayerCombatState!;
                lastTurn = state.TurnNumber;
                if (lastTurn > 30) throw new InvalidOperationException("Turn limit exceeded");
                Record("draw", new { cards = state.Hand.Cards.Select(c => c.Id.Entry).ToArray() });
                int plays = 0;
                while (!CombatManager.Instance.IsOverOrEnding && state.Phase == PlayerTurnPhase.Play)
                {
                    var card = state.Hand.Cards.FirstOrDefault(c => c.CanPlay());
                    if (card == null) break;
                    if (++plays > 50) throw new InvalidOperationException("Per-turn play limit exceeded");
                    var target = card.TargetType == TargetType.AnyEnemy ? enemy : null;
                    Record("card_before", new { card = card.Id.Entry, cost = card.EnergyCost.GetAmountToSpend() });
                    // Same resource/autoplay sequence as the original WhisperingEarring relic.
                    await card.SpendResources();
                    await CardCmd.AutoPlay(new ThrowingPlayerChoiceContext(), card, target, AutoPlayType.Default, skipXCapture: true);
                    Record("card_after", new { card = card.Id.Entry });
                    // Direct autoplay runs outside ActionExecutor, so invoke its normal safe-point check.
                    if (await CombatManager.Instance.CheckWinCondition()) break;
                }
                if (!CombatManager.Instance.IsOverOrEnding)
                {
                    Record("end_turn");
                    PlayerCmd.EndTurn(player, canBackOut: false);
                }
            }
            await Until(() => won || player.Creature.IsDead, "combat result");
            if (!won) throw new InvalidOperationException("Player lost test combat");
            Record("victory");
            WriteResult(true, null);
            exit = 0;
        }
        catch (Exception ex)
        {
            GD.PrintErr("[QQBOT_TEST] " + ex);
            WriteResult(false, ex.ToString());
        }
        finally
        {
            CombatManager.Instance.CombatWon -= OnWon;
            // Dispose the live combat scene through the game's normal path before engine shutdown.
            // Pet/card VFX can still own native objects when quitting directly from a coverage sweep.
            if (DuelPrototype.OwnsCombat)
            {
                try
                {
                    await NGame.Instance!.ReturnToMainMenu();
                    for (int frame = 0; frame < 10; frame++)
                        await NGame.Instance.ToSignal(NGame.Instance.GetTree(), SceneTree.SignalName.ProcessFrame);
                }
                catch (Exception cleanup)
                {
                    GD.PrintErr("[QQBOT_CLEANUP] " + cleanup);
                    exit = 1;
                }
            }
            NonInteractiveMode.AutoSlayerCheck = () => false;
            NGame.Instance.GetTree().Quit(exit);
        }
    }

    private static void OnWon(CombatRoom room) => won = true;
    private static async Task Until(Func<bool> predicate, string stage)
    {
        var timer = Stopwatch.StartNew();
        while (!predicate())
        {
            if (timer.Elapsed > TimeSpan.FromSeconds(25)) throw new TimeoutException(stage);
            await NGame.Instance.ToSignal(NGame.Instance.GetTree(), SceneTree.SignalName.ProcessFrame);
        }
    }

    private static void WriteResult(bool passed, string? error)
    {
        System.IO.File.WriteAllText(Output, JsonSerializer.Serialize(new {
            passed, error, gameVersion = GameBuild.Version, enemy = "QQBotTrainingDummy",
            victory = won, events
        }, new JsonSerializerOptions { WriteIndented = true }));
    }
}
