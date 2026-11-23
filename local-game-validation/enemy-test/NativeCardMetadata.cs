using System.Text.Json;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Models;

namespace QQBotEnemyTest;

internal static class NativeCardMetadata
{
    internal static void Export(Player owner)
    {
        LocManager.Instance.SetLanguage("zhs");
        var rows = new Dictionary<string,object>();
        var combat = owner.Creature.CombatState!;
        foreach (var canonical in ModelDb.AllCards)
        {
            if (canonical.MultiplayerConstraint == CardMultiplayerConstraint.MultiplayerOnly) continue;
            foreach (bool upgraded in new[]{false,true})
            {
                var card = combat.CreateCard(canonical,owner);
                if(upgraded) {
                    if(!card.IsUpgradable) continue;
                    card.UpgradeInternal(); card.FinalizeUpgradeInternal();
                }
                rows[card.GetType().Name+(upgraded?"+":"")] = new {
                    id=card.Id.Entry, title=card.Title, type=card.Type.ToString(), rarity=card.Rarity.ToString(),
                    cost=card.EnergyCost.GetWithModifiers(CostModifiers.Local), costsX=card.EnergyCost.CostsX,
                    stars=card.CurrentStarCost, description=card.GetDescriptionForPile(PileType.None)
                };
            }
        }
        var path=Path.Combine(Path.GetDirectoryName(Environment.GetEnvironmentVariable("QQBOT_TEST_OUTPUT"))!,"native-card-metadata.json");
        File.WriteAllText(path,JsonSerializer.Serialize(new {gameVersion=GameBuild.Version,modelHash=GameBuild.ModelHash,cards=rows},new JsonSerializerOptions{WriteIndented=true}));
    }
}
