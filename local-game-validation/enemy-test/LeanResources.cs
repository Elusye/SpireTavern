using System.Reflection;
using HarmonyLib;
using MegaCrit.Sts2.Core.Commands;
using MegaCrit.Sts2.Core.Assets;
using MegaCrit.Sts2.Core.Nodes;

namespace QQBotEnemyTest;

internal static class LeanResources
{
    internal static bool Enabled => System.Environment.GetEnvironmentVariable("QQBOT_RESOURCE_VARIANT") == "lean";
}

// Presentation-only command entrypoints. No card, resource payment or damage code is replaced.
[HarmonyPatch]
internal static class LeanVfxPatch
{
    private static IEnumerable<MethodBase> TargetMethods() => typeof(VfxCmd).GetMethods(BindingFlags.Static | BindingFlags.Public)
        .Where(m => m.ReturnType == typeof(void) && m.Name.StartsWith("Play"));
    private static bool Prefix() => !LeanResources.Enabled;
}

// Disabling Enabled alone still executes cache-unload logic, which can dispose live transition assets.
[HarmonyPatch(typeof(PreloadManager), "LoadAssetSets")]
internal static class LeanPreloadSessionPatch
{
    private static bool Prefix(ref Task<AssetLoadingSession> __result)
    {
        if (!LeanResources.Enabled) return true;
        __result = Task.FromResult(AssetLoadingSession.Empty());
        return false;
    }
}

[HarmonyPatch]
internal static class LeanTransitionPatch
{
    private static IEnumerable<MethodBase> TargetMethods() => typeof(NTransition).GetMethods(BindingFlags.Public | BindingFlags.Instance)
        .Where(m => m.ReturnType == typeof(Task) && (m.Name == "FadeIn" || m.Name == "FadeOut"));
    private static bool Prefix(ref Task __result)
    {
        if (!LeanResources.Enabled) return true;
        __result = Task.CompletedTask;
        return false;
    }
}

// These are only assets actually requested by the live scenes, not the bulk game asset set.
// PackedScene/material/script wrappers must outlive native scene references across repeated runs.
// Retain the small lazy cache for the engine lifetime rather than explicitly disposing live wrappers.
[HarmonyPatch(typeof(AssetCache), nameof(AssetCache.UnloadMissedCacheAssets))]
internal static class LeanLazyCacheLifetimePatch
{
    private static bool Prefix() => !LeanResources.Enabled;
}
