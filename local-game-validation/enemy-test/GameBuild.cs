using System.Text.Json;

namespace QQBotEnemyTest;

internal static class GameBuild
{
    internal const string Version = "0.111.1";
    internal static readonly string ModelHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.IO.File.ReadAllBytes(typeof(GameBuild).Assembly.Location))).ToLowerInvariant();

    internal static void Verify()
    {
        using var release = JsonDocument.Parse(System.IO.File.ReadAllText(
            System.IO.Path.Combine(System.Environment.CurrentDirectory, "release_info.json")));
        var actual = release.RootElement.GetProperty("version").GetString();
        if (actual != "v" + Version)
            throw new InvalidOperationException($"This duel model requires v{Version}; found {actual}");
    }
}
