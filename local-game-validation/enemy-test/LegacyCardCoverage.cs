using System.Text.Json;
using Godot;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Entities.Cards;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.GameActions.Multiplayer;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Cards;
using MegaCrit.Sts2.Core.Models.Characters;
using MegaCrit.Sts2.Core.Models.Relics;
using MegaCrit.Sts2.Core.Nodes.Rooms;
using MegaCrit.Sts2.Core.Runs;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Unlocks;

namespace QQBotEnemyTest;

internal static class LegacyCardCoverage
{
    internal static string Job => System.Environment.GetEnvironmentVariable("QQBOT_COVERAGE_JOB") ?? "Ironclad";
    internal static CharacterModel Character => Job switch {
        "Silent" => ModelDb.Character<Silent>(), "Regent" => ModelDb.Character<Regent>(),
        "Necrobinder" => ModelDb.Character<Necrobinder>(), "Defect" => ModelDb.Character<Defect>(),
        _ => ModelDb.Character<Ironclad>()
    };
    private static readonly ThrowingPlayerChoiceContext context = new();
    private static object View(Player p) => new { hp = p.Creature.CurrentHp, block = p.Creature.Block,
        energy = p.PlayerCombatState!.Energy, stars = p.PlayerCombatState.Stars,
        hand = p.PlayerCombatState.Hand.Cards.Select(c => c.Id.Entry).ToArray(),
        powers = p.Creature.Powers.Select(v => new { id=v.Id.Entry, amount=v.Amount }).ToArray(),
        orbs = p.PlayerCombatState.OrbQueue.Orbs.Select(o=>o.Id.Entry).ToArray(), ostyHp = p.Osty?.CurrentHp };

    internal static async Task Run(Player actor, Action<string,bool,bool> check)
    {
        var opponent = Player.CreateForNewRun<Ironclad>(new UnlockState(SaveManager.Instance.Progress),2UL);
        ((RunState)actor.RunState).AddPlayerDebug(opponent,-1);
        opponent.ResetCombatState();
        var combat=(CombatState)actor.Creature.CombatState!;
        combat.AddPlayer(opponent);
        NCombatRoom.Instance!.AddCreature(opponent.Creature);
        DuelPrototype.Fighters=new[]{actor,opponent};
        DuelPrototype.Active=true;
        DuelPrototype.OwnsCombat=true;
        DuelPrototype.Planning=false;
        var records = new List<object>();
        var output=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(System.Environment.GetEnvironmentVariable("QQBOT_TEST_OUTPUT"))!,"card-coverage.json");
        var names = Job=="Generated" ? LegacyCardCatalog.Generated : LegacyCardCatalog.Jobs[Job].Concat(Job switch {
            "Silent" => new[]{"Shiv"}, "Regent" => new[]{"SovereignBlade"},
            "Necrobinder" => new[]{"Soul"}, _ => Array.Empty<string>()
        }).ToArray();
        int offset=int.TryParse(System.Environment.GetEnvironmentVariable("QQBOT_COVERAGE_OFFSET"),out var start)?start:0;
        int limit=int.TryParse(System.Environment.GetEnvironmentVariable("QQBOT_COVERAGE_LIMIT"),out var amount)?amount:names.Length;
        bool allPassed=true;
        try
        {
            foreach(var name in names.Skip(offset).Take(limit))
            foreach(bool upgrade in new[]{false,true})
            {
                string? error=null;
                bool playable=false;
                object? before=null,after=null,following=null,metadata=null;
                try
                {
                    GD.Print($"[QQBOT_COVERAGE] {Job}/{name}{(upgrade?"+":"")} starting");
                    DuelPrototype.Actor=actor;
                    DuelTurns.CurrentPlayer=actor;
                    foreach(var p in DuelPrototype.Fighters)
                    {
                        foreach(var power in p.Creature.Powers.ToArray()) await PowerCmd.Remove(power);
                        await CardPileCmd.RemoveFromCombat(p.PlayerCombatState!.AllPiles.SelectMany(pile=>pile.Cards).ToArray());
                        await CreatureCmd.SetMaxHp(p.Creature,10000);
                        p.Creature.SetCurrentHpInternal(p==actor?5000:10000);
                        p.Creature.LoseBlockInternal(p.Creature.Block);
                        await PlayerCmd.SetEnergy(10,p);
                        p.PlayerCombatState.Stars=10;
                        p.PlayerCombatState.Phase=PlayerTurnPhase.Play;
                        for(int i=0;i<8;i++) await CardPileCmd.Add(combat.CreateCard<StrikeIronclad>(p),PileType.Draw,skipVisuals:true);
                        await CardPileCmd.Add(combat.CreateCard<DefendIronclad>(p),PileType.Discard,skipVisuals:true);
                        await CardPileCmd.Add(combat.CreateCard<StrikeIronclad>(p),PileType.Exhaust,skipVisuals:true);
                    }
                    if(Job=="Necrobinder") await OstyCmd.Summon(context,actor,10,null);
                    var card=combat.CreateCard(LegacyCardCatalog.Canonical(name),actor);
                    if(upgrade) CardCmd.Upgrade(card);
                    metadata=new { id=card.Id.Entry, title=card.Title, type=card.Type.ToString(),
                        cost=card.EnergyCost.GetWithModifiers(CostModifiers.Local), costsX=card.EnergyCost.CostsX,
                        stars=card.CurrentStarCost, description=card.GetDescriptionForPile(PileType.None) };
                    await CardPileCmd.Add(card,PileType.Hand,skipVisuals:true);
                    if(name=="GrandFinale") await CardPileCmd.RemoveFromCombat(actor.PlayerCombatState!.DrawPile.Cards.ToArray());
                    using var selector=CardSelectCmd.PushSelector(new VakuuCardSelector());
                    playable=card.CanPlay();
                    if(!playable) throw new InvalidOperationException("Fixture did not meet card play conditions");
                    before=new[]{View(actor),View(opponent)};
                    await card.SpendResources();
                    await CardCmd.AutoPlay(context,card,card.TargetType==TargetType.AnyEnemy?opponent.Creature:null,
                        AutoPlayType.Default,skipXCapture:true,skipCardPileVisuals:true);
                    after=new[]{View(actor),View(opponent)};
                    await DuelTurns.End(actor);
                    await DuelTurns.Start(opponent,false);
                    await DuelTurns.End(opponent);
                    await DuelTurns.Start(actor,false);
                    following=new[]{View(actor),View(opponent)};
                }
                catch(Exception ex){error=ex.ToString();allPassed=false;GD.PrintErr($"[QQBOT_COVERAGE] {name}: {ex}");}
                records.Add(new {name,upgrade,metadata,playable,passed=error==null,error,before,after,following});
                System.IO.File.WriteAllText(output,JsonSerializer.Serialize(new{gameVersion=GameBuild.Version,modelHash=GameBuild.ModelHash,job=Job,allPassed,records},new JsonSerializerOptions{WriteIndented=true}));
            }
            check($"{Job} base/upgraded cards and following turns",allPassed,true);
        }
        finally {DuelPrototype.Active=false;DuelPrototype.Actor=null;}
    }
}
