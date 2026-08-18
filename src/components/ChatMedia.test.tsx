import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ExtensionPanel, RichMessageContent } from "./ChatMedia";
import type { Message } from "../core/types";

afterEach(cleanup);

describe("chat extension panel", () => {
  it("renders existing private-chat features as an ordered vertical menu", () => {
    const onSelect = vi.fn();
    render(<ExtensionPanel onSelect={onSelect} onClose={vi.fn()} />);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["照片", "语音", "转账", "一起听", "茶侣岛", "切换模型", "见面"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "切换模型" }));
    expect(onSelect).toHaveBeenCalledWith("model");
    fireEvent.click(screen.getByRole("menuitem", { name: "见面" }));
    expect(onSelect).toHaveBeenCalledWith("meet");
  });
  it("omits calling shortcuts and closes from the handle", () => {
    const onClose = vi.fn();
    render(<ExtensionPanel onSelect={vi.fn()} onClose={onClose} />);
    expect(
      screen.queryByRole("menuitem", { name: "语音通话" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "视频通话" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "关闭更多功能" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("renders a dedicated text-image card without a generation action", () => {
    const message: Message = {
      id: "m",
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      conversationId: "v",
      senderType: "character",
      senderId: "c",
      content: "天快亮了。",
      kind: "image",
      attachments: [
        {
          type: "text-image",
          description: "医院休息室里，窗外的天空刚刚泛白。",
          intent: "environment",
          characterId: "c",
          generationEventId: "e",
          createdAt: 1,
        },
      ],
      status: "complete",
    };
    render(
      <MemoryRouter>
        <RichMessageContent message={message} assets={new Map()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("分享了一张图片")).toBeInTheDocument();
    expect(screen.getByText("文字图片")).toBeInTheDocument();
    expect(screen.getByText(/医院休息室/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /生成图片/ }),
    ).not.toBeInTheDocument();
  });
  it("renders the original above a divider and the Chinese translation below", () => {
    const translated: Message = {
      id: "translated",
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      conversationId: "c",
      senderType: "character",
      senderId: "ch",
      content: "I found you.",
      status: "complete",
      translation: {
        targetLanguage: "zh-CN",
        text: "我找到你了。",
        sourceHash: "hash",
        status: "complete",
        model: "translator",
        updatedAt: 2,
      },
    };
    const { container } = render(
      <MemoryRouter>
        <RichMessageContent message={translated} assets={new Map()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("I found you.")).toBeInTheDocument();
    expect(screen.getByText("我找到你了。")).toBeInTheDocument();
    expect(
      container.querySelector(".translated-message-text>i"),
    ).toBeInTheDocument();
  });
  it("shows only the original while translation is pending", () => {
    const pending: Message = {
      id: "pending",
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      conversationId: "c",
      senderType: "character",
      senderId: "ch",
      content: "Still here.",
      status: "complete",
      translation: {
        targetLanguage: "zh-CN",
        sourceHash: "hash",
        status: "pending",
        updatedAt: 2,
      },
    };
    const { container } = render(
      <MemoryRouter>
        <RichMessageContent message={pending} assets={new Map()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Still here.")).toBeInTheDocument();
    expect(
      container.querySelector(".translated-message-text"),
    ).not.toBeInTheDocument();
  });
});


describe("sticker message rendering", () => {
  it("renders only the sticker image and never the semantic description", () => {
    const sticker: Message = {
      id: "sticker",
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      conversationId: "conversation",
      senderType: "character",
      senderId: "character",
      content: "[表情包]",
      kind: "sticker",
      attachments: [
        {
          type: "sticker",
          stickerId: "s",
          name: "无语",
          description: "无语地看着你",
          url: "https://example.com/sticker.png",
        },
      ],
      status: "complete",
    };
    render(
      <MemoryRouter>
        <RichMessageContent message={sticker} assets={new Map()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("img", { name: "无语" })).toBeInTheDocument();
    expect(screen.queryByText("无语地看着你")).not.toBeInTheDocument();
    expect(screen.queryByText("[表情包]")).not.toBeInTheDocument();
  });
});

describe("couple island invitation ticket", () => {
  const invitation = (overrides: Partial<Message> = {}, attachment: Partial<Extract<NonNullable<Message["attachments"]>[number], { type: "couple-island-invitation" }>> = {}): Message => ({
    id: "island-invite", schemaVersion: 1, createdAt: 1, updatedAt: 1, conversationId: "conversation", senderType: "character", senderId: "c", content: "邀请", kind: "couple-island-invitation", status: "complete",
    attachments: [{ type: "couple-island-invitation", cardRole: "invitation", characterId: "c", invitedBy: "character", state: "pending", ...attachment }], ...overrides,
  });

  it("renders a character invitation as a ticket with accept and decline actions", () => {
    render(<MemoryRouter><RichMessageContent message={invitation()} assets={new Map()} onCoupleIslandInvitationResponse={vi.fn(async () => {})} /></MemoryRouter>);
    expect(screen.getByText("茶侣岛邀请")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接受登岛" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "先不了" })).toBeInTheDocument();
    expect(screen.queryByText("ISLAND RESPONSE")).not.toBeInTheDocument();
  });

  it("responds from the card without opening the island", async () => {
    const onResponse = vi.fn(async () => {});
    render(<MemoryRouter><RichMessageContent message={invitation()} assets={new Map()} onCoupleIslandInvitationResponse={onResponse} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "接受登岛" }));
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledWith("island-invite", "accept"));
  });

  it("keeps user invitations in waiting state without user decision buttons", () => {
    render(<MemoryRouter><RichMessageContent message={invitation({ senderType: "user" }, { invitedBy: "user" })} assets={new Map()} onCoupleIslandInvitationResponse={vi.fn(async () => {})} /></MemoryRouter>);
    expect(screen.getByText("邀请已送达")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "接受登岛" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "先不了" })).not.toBeInTheDocument();
  });

  it("infers character source for legacy attachments and has no default button border", () => {
    const { container } = render(<MemoryRouter><RichMessageContent message={invitation({}, { invitedBy: undefined })} assets={new Map()} onCoupleIslandInvitationResponse={vi.fn(async () => {})} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "接受登岛" })).toBeInTheDocument();
    expect(container.querySelector(".couple-island-ticket-main")?.className).toBe("couple-island-ticket-main");
  });
});