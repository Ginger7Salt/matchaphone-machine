import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, getSetting } from "./db";
import {
  buildMusicListeningReport,
  clearMusicListeningReports,
  exportMusicReportSettings,
  generateMusicReportCommentary,
  getMusicReportPreferences,
  localDateKey,
  periodBounds,
  recordMusicListeningMilestone,
  recordMusicListeningSegment,
  removeCharacterFromMusicReports,
  restoreMusicReportSettings,
} from "./musicReport";
import { defaultProvider, type Character, type MusicListeningDailyAggregate, type MusicTrack } from "./types";

const track = (id: string, patch: Partial<MusicTrack> = {}): MusicTrack => ({ id, schemaVersion: 1, createdAt: 1, updatedAt: 1, importedAt: 1, source: "direct-url", title: `歌曲${id}`, artists: ["茶茶"], directUrl: `https://example.com/${id}.mp3`, durationMs: 120_000, ...patch });
const character = { id: "c1", name: "小茶", personality: "温柔", speakingStyle: "简短", contactState: { status: "friend" } } as Character;

beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(() => vi.unstubAllGlobals());

describe("music listening reports", () => {
  it("records real progress across local midnight without a schema migration", async () => {
    const start = new Date(2026, 7, 10, 23, 59, 50).getTime(), end = start + 20_000;
    await recordMusicListeningSegment({ track: track("night"), listenedMs: 20_000, startedAt: start, endedAt: end, characterId: "c1" });
    const first = await getSetting<MusicListeningDailyAggregate | null>(`music-listening-day:${localDateKey(start)}`, null);
    const second = await getSetting<MusicListeningDailyAggregate | null>(`music-listening-day:${localDateKey(end)}`, null);
    expect(first?.totalListenedMs).toBe(10_000);
    expect(second?.totalListenedMs).toBe(10_000);
    expect(first?.characterMs.c1).toBe(10_000);
    expect(second?.tracks.night.title).toBe("歌曲night");
    expect(db.verno).toBe(15);
  });

  it("aggregates milestones, sources, artists and together-listening attribution", async () => {
    const at = new Date(2026, 7, 10, 12).getTime(), a = track("a"), b = track("b", { source: "local-file", artists: ["抹茶"] });
    await recordMusicListeningSegment({ track: a, listenedMs: 90_000, startedAt: at, endedAt: at + 90_000, characterId: "c1" });
    await recordMusicListeningMilestone({ track: a, at, kind: "start", characterId: "c1", selectedBy: "character" });
    await recordMusicListeningMilestone({ track: a, at: at + 90_000, kind: "complete" });
    await recordMusicListeningSegment({ track: b, listenedMs: 20_000, startedAt: at + 100_000, endedAt: at + 120_000 });
    await recordMusicListeningMilestone({ track: b, at: at + 120_000, kind: "skip" });
    const report = await buildMusicListeningReport("week", "2026-08-10");
    expect(report.totalListenedMs).toBe(110_000);
    expect(report.validPlays).toBe(1);
    expect(report.completes).toBe(1);
    expect(report.skips).toBe(1);
    expect(report.tracks[0]).toMatchObject({ trackId: "a", listenedMs: 90_000 });
    expect(report.artists.map((item) => item.name)).toEqual(["茶茶", "抹茶"]);
    expect(report.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "direct-url", listenedMs: 90_000 }), expect.objectContaining({ source: "local-file", listenedMs: 20_000 })]));
    expect(report.characters[0]).toMatchObject({ characterId: "c1", listenedMs: 90_000, selectedCount: 1, trackIds: ["a"] });
  });

  it("uses Monday week boundaries and builds monthly and yearly trends", async () => {
    expect(periodBounds("week", "2026-08-12")).toMatchObject({ startDate: "2026-08-10", endDate: "2026-08-16" });
    const january = new Date(2026, 0, 15, 18).getTime(), august = new Date(2026, 7, 10, 18).getTime();
    await recordMusicListeningSegment({ track: track("jan"), listenedMs: 60_000, startedAt: january, endedAt: january + 60_000 });
    await recordMusicListeningSegment({ track: track("aug"), listenedMs: 120_000, startedAt: august, endedAt: august + 120_000 });
    const month = await buildMusicListeningReport("month", "2026-08-10"), year = await buildMusicListeningReport("year", "2026-08-10");
    expect(month.daily).toHaveLength(31);
    expect(month.totalListenedMs).toBe(120_000);
    expect(year.totalListenedMs).toBe(180_000);
    expect(year.monthly[0].listenedMs).toBe(60_000);
    expect(year.monthly[7].listenedMs).toBe(120_000);
  });

  it("caches factual character commentary and limits manual regeneration to once per day", async () => {
    const at = new Date(2026, 7, 10, 12).getTime();
    await recordMusicListeningSegment({ track: track("a"), listenedMs: 60_000, startedAt: at, endedAt: at + 60_000, characterId: "c1" });
    const report = await buildMusicListeningReport("week", "2026-08-10"), fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "这周我们听见了很温柔的旋律。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "重新翻看，还是很喜欢这段音乐时光。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = { ...defaultProvider, apiKey: "test", baseUrl: "https://api.test/v1", stream: false };
    const first = await generateMusicReportCommentary(report, character, provider), cached = await generateMusicReportCommentary(report, character, provider);
    expect(first.text).toContain("温柔的旋律"); expect(cached.text).toBe(first.text); expect(fetchMock).toHaveBeenCalledTimes(1);
    const manual = await generateMusicReportCommentary(report, character, provider, true);
    expect(manual.text).toContain("重新翻看"); expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(generateMusicReportCommentary(report, character, provider, true)).rejects.toThrow("今天已经重新生成过");
  });

  it("backs up, restores, clears and removes character-specific report data", async () => {
    const at = new Date(2026, 7, 10, 12).getTime();
    await recordMusicListeningSegment({ track: track("a"), listenedMs: 60_000, startedAt: at, endedAt: at + 60_000, characterId: "c1" });
    await recordMusicListeningMilestone({ track: track("a"), at, kind: "start", characterId: "c1", selectedBy: "character" });
    const exported = await exportMusicReportSettings();
    expect(exported.stats).toHaveLength(1); expect((await getMusicReportPreferences()).trackingStartedAt).toBeGreaterThan(0);
    await removeCharacterFromMusicReports("c1");
    let report = await buildMusicListeningReport("week", "2026-08-10");
    expect(report.totalListenedMs).toBe(60_000); expect(report.characters).toHaveLength(0);
    await clearMusicListeningReports(); expect((await buildMusicListeningReport("week", "2026-08-10")).totalListenedMs).toBe(0);
    await restoreMusicReportSettings(exported.stats, exported.comments, exported.preferences);
    report = await buildMusicListeningReport("week", "2026-08-10");
    expect(report.totalListenedMs).toBe(60_000); expect(report.characters[0].characterId).toBe("c1");
  });
});