using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.Characters;
using MegaCrit.Sts2.Core.Entities.Players;
using System.Text.Json;
using HarmonyLib;
using MegaCrit.Sts2.Core.Unlocks;

namespace QQBotEnemyTest;

internal static class DuelConfig
{
    internal sealed record Party(string Job, string[] Deck);
    internal sealed record Request(string Seed, Party[] Players);
    internal static Request? Input { get; private set; } = Read();
    internal static void Reload(string path)
    {
        System.Environment.SetEnvironmentVariable("QQBOT_DUEL_INPUT",path);
        Input=Read();
    }
    private static Request? Read()
    {
        var path = System.Environment.GetEnvironmentVariable("QQBOT_DUEL_INPUT");
        if (string.IsNullOrEmpty(path)) return null;
        var request = JsonSerializer.Deserialize<Request>(System.IO.File.ReadAllText(path),new JsonSerializerOptions{PropertyNameCaseInsensitive=true})!;
        if (request.Players?.Length != 2 || string.IsNullOrEmpty(request.Seed) || request.Seed.Length>64) throw new ArgumentException("Invalid duel request");
        foreach (var party in request.Players)
        {
            if (!LegacyCardCatalog.Jobs.TryGetValue(party.Job,out var cards) || party.Deck?.Length is not (>=1 and <=300)) throw new ArgumentException("Invalid party");
            foreach(var id in party.Deck)
                if (id == null || !cards.Contains(id.EndsWith('+')?id[..^1]:id)) throw new ArgumentException("Unsupported saved card: "+id);
        }
        return request;
    }
    internal static string First => Input?.Players[0].Job ?? System.Environment.GetEnvironmentVariable("QQBOT_DUEL_FIRST") ?? "Ironclad";
    internal static string Second => Input?.Players[1].Job ?? System.Environment.GetEnvironmentVariable("QQBOT_DUEL_SECOND") ?? "Defect";
    internal static string Seed => Input?.Seed ?? "QQBOTMECHANICS";
    internal static bool LegacyDeck => System.Environment.GetEnvironmentVariable("QQBOT_DUEL_DECK") == "legacy";
    internal static CharacterModel Character(string job) => job switch {
        "Ironclad" => ModelDb.Character<Ironclad>(), "Silent" => ModelDb.Character<Silent>(),
        "Regent" => ModelDb.Character<Regent>(), "Necrobinder" => ModelDb.Character<Necrobinder>(),
        "Defect" => ModelDb.Character<Defect>(), _ => throw new ArgumentException("Unknown character: " + job)
    };
    internal static void Configure(Player player)
    {
        if (Input == null) return;
        var party=Input.Players[checked((int)player.NetId)-1];
        foreach(var card in player.Deck.Cards.ToArray()) player.Deck.RemoveInternal(card,silent:true);
        foreach(var id in party.Deck)
        {
            bool upgrade=id.EndsWith('+');
            var card=LegacyCardCatalog.Canonical(upgrade?id[..^1]:id).ToMutable();
            if (upgrade) {card.UpgradeInternal();card.FinalizeUpgradeInternal();}
            player.Deck.AddInternal(card,silent:true);
        }
        // Preserve the bot's starter-relic conversion: Ironclad starts with six extra maximum HP.
        if (party.Job=="Ironclad")
        {
            player.Creature.SetMaxHpInternal(player.Creature.MaxHp+6);
            player.Creature.SetCurrentHpInternal(player.Creature.MaxHp);
        }
    }
}

[HarmonyPatch(typeof(Player),nameof(Player.CreateForNewRun),new[]{typeof(CharacterModel),typeof(UnlockState),typeof(ulong)})]
internal static class SavedDuelDeckPatch
{
    private static void Postfix(Player __result) => DuelConfig.Configure(__result);
}
