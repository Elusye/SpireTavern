using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Factories;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Runs;

namespace QQBotEnemyTest;

// Two rival players are not a native co-op party. Keep the single-player card
// constraint for random generation as well as the saved/dealt card pools.
[HarmonyPatch(typeof(CardFactory), "FilterForPlayerCount")]
internal static class DuelGeneration
{
    internal static readonly HashSet<string> Excluded=new(){"Feed","TheHunt","Royalties","TheScythe","GeneticAlgorithm"};
    private static bool Prefix(IRunState runState, IEnumerable<CardModel> options, ref IEnumerable<CardModel> __result)
    {
        if(!DuelPrototype.Active) return true;
        __result=options.Where(c=>c.MultiplayerConstraint!=CardMultiplayerConstraint.MultiplayerOnly && !Excluded.Contains(c.GetType().Name));
        return false;
    }
}

[HarmonyPatch(typeof(CardPoolModel), nameof(CardPoolModel.GetUnlockedCards))]
internal static class DuelPoolConstraint
{
    private static void Prefix(ref CardMultiplayerConstraint multiplayerConstraint)
    {
        if(DuelPrototype.Active) multiplayerConstraint=CardMultiplayerConstraint.SingleplayerOnly;
    }
    private static void Postfix(ref IEnumerable<CardModel> __result)
    {
        if(DuelPrototype.Active) __result=__result.Where(c=>c.MultiplayerConstraint!=CardMultiplayerConstraint.MultiplayerOnly
            && c.Rarity!=CardRarity.Ancient && !DuelGeneration.Excluded.Contains(c.GetType().Name));
    }
}
