import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Character, MeetEntry, MeetSession } from "../core/types";
import MeetSessionPage from "./MeetSessionPage";

const mocked = vi.hoisted(() => ({ state: null as any }));
vi.mock("../core/store", () => ({ useStore: () => mocked.state }));

const characters = [
  { id: "one", name: "甲", avatar: "" },
  { id: "two", name: "乙", avatar: "" },
] as Character[];

function user(roundId: string, generation?: MeetEntry["generation"]): MeetEntry {
  return {
    id: `user-${roundId}`,
    roundId,
    senderType: "user",
    content: "我们继续聊。",
    generation,
    createdAt: 1,
  };
}

function session(entries: MeetEntry[]): MeetSession {
  return {
    id: "meet-ui",
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    participantIds: ["one", "two"],
    initiator: "user",
    scene: { opening: "开场", location: "客厅" },
    suggestionsEnabled: false,
    status: "active",
    entries,
    startedAt: 1,
    lastActivityAt: 1,
  };
}

function setup(entries: MeetEntry[]) {
  mocked.state = {
    meetSessions: [session(entries)],
    characters,
    settings: { userName: "我", userAvatar: "" },
    reload: vi.fn().mockResolvedValue(undefined),
  };
  return render(
    <MemoryRouter initialEntries={["/meet/meet-ui"]}>
      <Routes>
        <Route path="/meet/:id" element={<MeetSessionPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MeetSessionPage unified rounds", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(cleanup);

  it("renders shared narration once and preserves interleaved dialogue order", () => {
    setup([
      user("round"),
      {
        id: "n1",
        roundId: "round",
        senderType: "system",
        narration: "雨落在窗边。",
        format: "unified-round-v1",
        createdAt: 2,
      },
      {
        id: "d1",
        roundId: "round",
        senderType: "character",
        senderId: "one",
        dialogue: "先坐吧。",
        format: "unified-round-v1",
        createdAt: 3,
      },
      {
        id: "n2",
        roundId: "round",
        senderType: "system",
        narration: "门外响起脚步声。",
        format: "unified-round-v1",
        createdAt: 4,
      },
      {
        id: "d2",
        roundId: "round",
        senderType: "character",
        senderId: "two",
        dialogue: "我来晚了。",
        format: "unified-round-v1",
        createdAt: 5,
      },
    ]);
    expect(screen.getAllByText("雨落在窗边。")).toHaveLength(1);
    const ordered = [
      ...document.querySelectorAll(
        ".meet-round-narration-copy, .unified-round-dialogue .thread-dialogue",
      ),
    ].map((node) => node.textContent?.trim());
    expect(ordered).toEqual([
      "雨落在窗边。",
      "先坐吧。",
      "门外响起脚步声。",
      "我来晚了。",
    ]);
  });

  it("does not repeat one legacy system narration across every character post", () => {
    setup([
      user("legacy"),
      {
        id: "legacy-narration",
        roundId: "legacy",
        senderType: "system",
        narration: "旧旁白只出现一次。",
        createdAt: 2,
      },
      {
        id: "legacy-one",
        roundId: "legacy",
        senderType: "character",
        senderId: "one",
        dialogue: "第一句。",
        createdAt: 3,
      },
      {
        id: "legacy-two",
        roundId: "legacy",
        senderType: "character",
        senderId: "two",
        dialogue: "第二句。",
        createdAt: 4,
      },
    ]);
    expect(screen.getAllByText("旧旁白只出现一次。")).toHaveLength(1);
  });

  it("shows one failure state and relabels old false-saving diagnostics", () => {
    setup([
      user("failed", {
        status: "failed",
        stage: "saving",
        saveResult: "failed",
        rawLength: 0,
      }),
    ]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("旧版生成未完成")).toBeInTheDocument();
    expect(screen.queryByText(/本地保存失败/)).not.toBeInTheDocument();
  });

  it("shows a rate-limit explanation and copies fallback diagnostics", async () => {
    setup([
      user("rate", {
        status: "failed",
        protocol: "unified-round-v1",
        runId: "run-rate",
        stage: "requesting",
        failureClass: "provider-rate-limit",
        normalizedResponse: false,
        model: "secondary-model",
        fallbackUsed: true,
        saveResult: "not-attempted",
        attempts: [
          {
            ordinal: 1,
            stage: "requesting",
            model: "primary-model",
            providerRole: "primary",
            httpStatus: 429,
            retryAfterSeconds: 30,
            errorKind: "rate",
            providerCode: "bad_response_status_code",
          },
          {
            ordinal: 2,
            stage: "requesting",
            model: "secondary-model",
            providerRole: "secondary-fallback",
            httpStatus: 429,
            retryAfterSeconds: 60,
            errorKind: "rate",
            providerCode: "bad_response_status_code",
          },
        ],
      }),
    ]);

    expect(
      screen.getByText(/当前模型暂时达到调用频率或额度限制/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制诊断" }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    const diagnostic = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(diagnostic).toContain("failureClass=provider-rate-limit");
    expect(diagnostic).toContain("normalizedResponse=false");
    expect(diagnostic).toContain("fallbackUsed=true");
    expect(diagnostic).toContain("attempt1.model=primary-model");
    expect(diagnostic).toContain("attempt1.providerRole=primary");
    expect(diagnostic).toContain("attempt1.httpStatus=429");
    expect(diagnostic).toContain("attempt1.retryAfterSeconds=30");
    expect(diagnostic).toContain("attempt2.providerRole=secondary-fallback");
    expect(diagnostic).not.toContain("我们继续聊");
  });
});
