using HarmonyLib;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.Models.Powers;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Nodes.Orbs;
using System.Reflection;

namespace QQBotEnemyTest;

[HarmonyPatch]
internal static class DuelNativeSchedulerPatch
{
    private static IEnumerable<MethodBase> TargetMethods() => typeof(CombatManager).GetMethods(BindingFlags.Instance|BindingFlags.NonPublic)
        .Where(m => m.ReturnType == typeof(Task) && new[]{"AfterAllPlayersReadyToEndTurn","AfterAllPlayersReadyToBeginEnemyTurn","ExecuteEnemyTurn"}.Contains(m.Name));
    private static bool Prefix(ref Task __result)
    {
        if (!DuelPrototype.OwnsCombat) return true;
        __result = WaitForReset();
        return false;
    }
    private static async Task WaitForReset()
    {
        while (DuelPrototype.OwnsCombat)
            await MegaCrit.Sts2.Core.Nodes.NGame.Instance!.ToSignal(MegaCrit.Sts2.Core.Nodes.NGame.Instance.GetTree(), Godot.SceneTree.SignalName.ProcessFrame);
    }
}

[HarmonyPatch(typeof(CombatManager), nameof(CombatManager.Reset))]
internal static class DuelResetOwnershipPatch
{
    private static void Postfix() { DuelPrototype.OwnsCombat = false; DuelTurns.CurrentPlayer = null; }
}

// Both rivals retain native Player side. These powers explicitly test CurrentSide
// instead of receiving turn participants, so also gate them by the real turn owner.
[HarmonyPatch]
internal static class DuelOwnTurnPowerPatch
{
    private static IEnumerable<MethodBase> TargetMethods()
    {
        yield return AccessTools.Method(typeof(RupturePower), nameof(RupturePower.BeforeCardPlayed));
        yield return AccessTools.Method(typeof(RupturePower), nameof(RupturePower.AfterDamageReceived));
        yield return AccessTools.Method(typeof(InfernoPower), nameof(InfernoPower.AfterDamageReceived));
        yield return AccessTools.Method(typeof(SpeedsterPower), nameof(SpeedsterPower.AfterCardDrawn));
    }
    private static bool Prefix(PowerModel __instance, ref Task __result)
    {
        if(!DuelPrototype.Active || __instance.Owner.Player==DuelTurns.CurrentPlayer) return true;
        __result=Task.CompletedTask;
        return false;
    }
}

// Queue state is native; orbital scene slots are presentation and are not authoritative in headless PvP.
[HarmonyPatch]
internal static class DuelOrbVisualPatch
{
    private static IEnumerable<MethodBase> TargetMethods() => typeof(NOrbManager).GetMethods(BindingFlags.Instance|BindingFlags.Public)
        .Where(m => m.ReturnType == typeof(void) && new[]{"RemoveSlotAnim","AddSlotAnim","ReplaceOrb","AddOrbAnim","EvokeOrbAnim","UpdateVisuals","ClearOrbs"}.Contains(m.Name));
    private static bool Prefix() => !DuelPrototype.Active;
}

[HarmonyPatch(typeof(CombatState), nameof(CombatState.IterateHookListeners))]
internal static class DuelHookOwnerPatch
{
    private static void Postfix(ref IEnumerable<AbstractModel> __result)
    {
        if (DuelPrototype.Active) __result = Scoped(__result);
    }
    private static IEnumerable<AbstractModel> Scoped(IEnumerable<AbstractModel> source)
    {
        foreach (var model in source)
        {
            var previous = DuelPrototype.Actor;
            var owner = DuelTurns.Owner(model);
            if (owner != null && DuelPrototype.Fighters.Contains(owner)) DuelPrototype.Actor = owner;
            try { yield return model; }
            finally { DuelPrototype.Actor = previous; }
        }
    }
}

[HarmonyPatch(typeof(CombatManager), "IsCombatEnding")]
internal static class DuelEndingPatch
{
    private static bool Prefix(ref bool __result)
    {
        if (!DuelPrototype.OwnsCombat) return true;
        // Native PvE termination expects a primary monster; PvP opponents are actual players.
        __result = DuelPrototype.Fighters.Any(p => p.Creature.IsDead);
        return false;
    }
}

[HarmonyPatch]
internal static class DuelWinConditionPatch
{
    private static IEnumerable<MethodBase> TargetMethods() => typeof(CombatManager).GetMethods(BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic)
        .Where(m => m.Name == nameof(CombatManager.CheckWinCondition) && m.ReturnType == typeof(Task<bool>));
    private static bool Prefix(ref Task<bool> __result)
    {
        if (!DuelPrototype.OwnsCombat) return true;
        // The PvE victory path revives co-op players and clears their cards. The duel owns termination.
        __result = Task.FromResult(DuelPrototype.Fighters.Any(p => p.Creature.IsDead));
        return false;
    }
}

[HarmonyPatch(typeof(CombatState), "get_Enemies")]
internal static class DuelEnemyCollectionPatch
{
    private static bool Prefix(ref IReadOnlyList<Creature> __result)
    {
        if (!DuelPrototype.Active || DuelPrototype.Actor == null) return true;
        __result = DuelPrototype.Opponents(DuelPrototype.Actor.Creature);
        return false;
    }
}

[HarmonyPatch(typeof(CombatState), nameof(CombatState.GetTeammatesOf))]
internal static class DuelTeamPatch
{
    private static bool Prefix(CombatState __instance, Creature creature, ref IReadOnlyList<Creature> __result)
    {
        var owner = creature.Player ?? creature.PetOwner;
        if (!DuelPrototype.Active || owner == null || !DuelPrototype.Fighters.Contains(owner)) return true;
        __result = __instance.Allies.Where(c => c == owner.Creature || c.PetOwner == owner).ToArray();
        return false;
    }
}

// PvP has no monster intent object. Keep the existing bot rule: Eye attack applies Weak to a player.
// Costs, upgrade values, attack hooks and damage still use native commands.
[HarmonyPatch(typeof(GoForTheEyes), "OnPlay")]
internal static class DuelEyesPatch
{
    private static bool Prefix(GoForTheEyes __instance, PlayerChoiceContext choiceContext, CardPlay cardPlay, ref Task __result)
    {
        if (!DuelPrototype.Active) return true;
        __result = Play(__instance, choiceContext, cardPlay);
        return false;
    }
    private static async Task Play(GoForTheEyes card, PlayerChoiceContext context, CardPlay play)
    {
        await DamageCmd.Attack(card.DynamicVars.Damage.BaseValue).FromCard(card, play).Targeting(play.Target!).Execute(context);
        if (play.Target!.IsAlive)
            await PowerCmd.Apply<WeakPower>(context, play.Target, card.DynamicVars.Weak.BaseValue, card.Owner.Creature, card);
    }
}
