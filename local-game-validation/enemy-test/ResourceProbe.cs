using System.Diagnostics;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.Core.Nodes;

namespace QQBotEnemyTest;

internal static class ResourceProbe
{
    internal static void Mark(string stage, int? iteration = null)
    {
        var path = System.Environment.GetEnvironmentVariable("QQBOT_BENCH_PHASES");
        if (string.IsNullOrEmpty(path)) return;
        using var process = Process.GetCurrentProcess();
        System.IO.File.AppendAllText(path, JsonSerializer.Serialize(new {
            stage, iteration, utc = DateTimeOffset.UtcNow, processStartUtc = process.StartTime.ToUniversalTime(), workingBytes = process.WorkingSet64,
            privateBytes = process.PrivateMemorySize64, managedBytes = GC.GetTotalMemory(false),
            cachedAssets = MegaCrit.Sts2.Core.Assets.PreloadManager.Cache.GetCacheKeys().Count(),
            cpuSeconds = process.TotalProcessorTime.TotalSeconds
        }) + "\n");
    }

    internal static async Task<bool> Repeat(string name, int count)
    {
        var original = System.Environment.GetEnvironmentVariable("QQBOT_TEST_OUTPUT")!;
        var parent = System.IO.Path.GetDirectoryName(original)!;
        var runs = new List<object>();
        bool allPassed = true;
        for (int index = 1; index <= count; index++)
        {
            var directory = System.IO.Path.Combine(parent, $"match-{index:D2}");
            System.IO.Directory.CreateDirectory(directory);
            System.Environment.SetEnvironmentVariable("QQBOT_TEST_OUTPUT", System.IO.Path.Combine(directory, "result.json"));
            Mark("match_start", index);
            var timer = Stopwatch.StartNew();
            bool passed = await MechanicSuite.Run(name);
            double seconds = timer.Elapsed.TotalSeconds;
            Mark("match_end", index);
            runs.Add(new { iteration = index, passed, seconds, directory });
            if (!passed) { allPassed = false; break; }
            await NGame.Instance!.ReturnToMainMenu();
            DuelPrototype.Fighters = Array.Empty<MegaCrit.Sts2.Core.Entities.Players.Player>();
            for (int frame = 0; frame < 5; frame++)
                await NGame.Instance.ToSignal(NGame.Instance.GetTree(), SceneTree.SignalName.ProcessFrame);
            // Do not force GC: measure normal cache/heap retention rather than an artificial minimum.
            Mark("match_cleaned", index);
        }
        System.Environment.SetEnvironmentVariable("QQBOT_TEST_OUTPUT", original);
        if (int.TryParse(System.Environment.GetEnvironmentVariable("QQBOT_BENCH_IDLE"), out var idle) && idle > 0)
        {
            Mark("idle_start");
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(idle, 60)));
            Mark("idle_end");
        }
        System.IO.File.WriteAllText(original, JsonSerializer.Serialize(new { passed = allPassed, benchmark = true, runs }));
        return allPassed;
    }
}
